import { describe, expect, it, beforeAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';

const app = createApp();
const uid = Date.now().toString(36);

async function signup(tag: string) {
  const r = await request(app).post('/api/auth/register').send({ restaurantName: `Inv ${tag} ${uid}`, name: 'Owner', email: `inv-${tag}-${uid}@example.com`, password: 'Password123!' });
  return { slug: r.body.restaurant.slug as string, auth: { Authorization: `Bearer ${r.body.accessToken}` } };
}

describe('inventory', () => {
  let a: Awaited<ReturnType<typeof signup>>, b: Awaited<ReturnType<typeof signup>>;
  let flour: string, cheese: string, pizza: string;
  const stock = (id: string, body: object, h = a.auth) => request(app).post(`/api/ingredients/${id}/stock`).set(h).send(body);
  const ingredient = async (id: string) => (await request(app).get('/api/ingredients').set(a.auth)).body.find((i: any) => i.id === id);

  beforeAll(async () => {
    a = await signup('a'); b = await signup('b');
    flour = (await request(app).post('/api/ingredients').set(a.auth).send({ name: 'Flour', unit: 'kg', lowThreshold: 2 })).body.id;
    cheese = (await request(app).post('/api/ingredients').set(a.auth).send({ name: 'Cheese', unit: 'kg', lowThreshold: 1 })).body.id;
    const cat = await request(app).post('/api/categories').set(a.auth).send({ name: 'Pizza' });
    pizza = (await request(app).post('/api/products').set(a.auth).send({ categoryId: cat.body.id, name: 'Margherita', priceCents: 30000 })).body.id;
    await request(app).put('/api/restaurant').set(a.auth).send({ published: true, orderTypes: ['TAKEAWAY'], taxPercent: 0 });
  });

  it('tracks purchases, wastage and reconciliation in a ledger', async () => {
    expect((await stock(flour, { type: 'PURCHASE', qty: 10, note: 'Delivery' })).body.stockQty).toBe(10);
    expect((await stock(flour, { type: 'WASTAGE', qty: 1.5, note: 'Spilled' })).body.stockQty).toBe(8.5);
    const counted = await stock(flour, { type: 'COUNT', counted: 8 });
    expect(counted.body.stockQty).toBe(8);
    const moves = (await request(app).get(`/api/ingredients/${flour}/movements`).set(a.auth)).body;
    expect(moves.map((m: any) => [m.reason, m.delta]).reverse()).toEqual([['PURCHASE', 10], ['WASTAGE', -1.5], ['ADJUSTMENT', -0.5]]);
    expect((await stock(flour, { type: 'PURCHASE', qty: -3 })).status).toBe(400);
    expect((await stock(flour, { type: 'WASTAGE', qty: 0 })).status).toBe(400);
  });

  it('deducts recipe quantities exactly once when an order completes', async () => {
    await stock(cheese, { type: 'PURCHASE', qty: 1.2 });
    expect((await request(app).put(`/api/products/${pizza}/recipe`).set(a.auth).send({ items: [{ ingredientId: flour, qty: 0.25 }, { ingredientId: cheese, qty: 0.1 }] })).status).toBe(200);

    const o = await request(app).post(`/api/public/${a.slug}/orders`).send({ type: 'TAKEAWAY', customerName: 'Ina Ventory', customerPhone: '+919000000001', items: [{ productId: pizza, quantity: 3 }] });
    expect(o.status).toBe(201);
    const order = (await request(app).get('/api/orders?q=Ina').set(a.auth)).body.items[0];
    const patch = (s: string) => request(app).patch(`/api/orders/${order.id}/status`).set(a.auth).send({ status: s });
    for (const s of ['ACCEPTED', 'PREPARING', 'READY']) await patch(s);
    expect((await ingredient(flour)).stockQty).toBe(8); // nothing consumed before completion
    expect((await patch('COMPLETED')).status).toBe(200);
    expect((await patch('COMPLETED')).status).toBe(409); // cannot complete twice, so cannot double-deduct
    expect((await ingredient(flour)).stockQty).toBe(7.25);
    const c = await ingredient(cheese);
    expect(c.stockQty).toBeCloseTo(0.9, 5);
    expect(c.low).toBe(true); // 0.9 <= threshold 1
  });

  it('does not consume stock for cancelled orders', async () => {
    const before = (await ingredient(flour)).stockQty;
    await request(app).post(`/api/public/${a.slug}/orders`).send({ type: 'TAKEAWAY', customerName: 'Cal Cancel', customerPhone: '+919000000002', items: [{ productId: pizza, quantity: 1 }] });
    const order = (await request(app).get('/api/orders?q=Cal').set(a.auth)).body.items[0];
    await request(app).patch(`/api/orders/${order.id}/status`).set(a.auth).send({ status: 'CANCELLED' });
    expect((await ingredient(flour)).stockQty).toBe(before);
  });

  it('surfaces low stock on the dashboard from the database', async () => {
    const d = await request(app).get('/api/dashboard').set(a.auth);
    expect(d.body.lowStock.map((i: any) => i.name)).toEqual(['Cheese']);
  });

  it('serialises concurrent stock changes without losing updates', async () => {
    const before = (await ingredient(flour)).stockQty;
    await Promise.all(Array.from({ length: 5 }, () => stock(flour, { type: 'PURCHASE', qty: 1 })));
    expect((await ingredient(flour)).stockQty).toBe(before + 5);
  });

  it('isolates tenants and restricts roles', async () => {
    expect((await request(app).get('/api/ingredients').set(b.auth)).body).toEqual([]);
    expect((await stock(flour, { type: 'PURCHASE', qty: 1 }, b.auth)).status).toBe(404);
    expect((await request(app).delete(`/api/ingredients/${flour}`).set(b.auth)).status).toBe(404);
    expect((await request(app).put(`/api/products/${pizza}/recipe`).set(b.auth).send({ items: [] })).status).toBe(404);
    // a recipe may not reference another tenant's ingredient
    const cat = await request(app).post('/api/categories').set(b.auth).send({ name: 'X' });
    const p = await request(app).post('/api/products').set(b.auth).send({ categoryId: cat.body.id, name: 'Y', priceCents: 100 });
    expect((await request(app).put(`/api/products/${p.body.id}/recipe`).set(b.auth).send({ items: [{ ingredientId: flour, qty: 1 }] })).status).toBe(400);

    const k = await request(app).post('/api/staff').set(a.auth).send({ name: 'Kay Kitchen', email: `inv-k-${uid}@example.com`, password: 'Password123!', role: 'KITCHEN' });
    expect(k.status).toBe(201);
    const login = await request(app).post('/api/auth/login').send({ email: `inv-k-${uid}@example.com`, password: 'Password123!' });
    const kh = { Authorization: `Bearer ${login.body.accessToken}` };
    expect((await request(app).get('/api/ingredients').set(kh)).status).toBe(403);
    expect((await request(app).get('/api/orders').set(kh)).status).toBe(200); // kitchen still reaches the order routes
  });
});
