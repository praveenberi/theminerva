import { describe, expect, it, beforeAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';

const app = createApp();
const uid = Date.now().toString(36);

describe('table orders and payment before completion', () => {
  let auth: Record<string, string>, slug: string, burger: string;
  const tableOrder = (table: string, quantity = 1, who = 'Tia Table', extra: object = {}) =>
    request(app).post(`/api/public/${slug}/orders`).send({ type: 'DINE_IN', tableLabel: table, customerName: who, customerPhone: '+919300000001', items: [{ productId: burger, quantity }], ...extra });
  const orders = async () => (await request(app).get('/api/orders?pageSize=100').set(auth)).body.items as any[];
  const byNumber = async (n: number) => (await orders()).find((o) => o.number === n);
  const status = (id: string, s: string) => request(app).patch(`/api/orders/${id}/status`).set(auth).send({ status: s });
  const pay = (id: string) => request(app).patch(`/api/orders/${id}/payment`).set(auth).send({ paymentStatus: 'PAID' });

  beforeAll(async () => {
    const r = await request(app).post('/api/auth/register').send({ restaurantName: `Tbl ${uid}`, name: 'Owner', email: `tbl-${uid}@example.com`, password: 'Password123!' });
    auth = { Authorization: `Bearer ${r.body.accessToken}` }; slug = r.body.restaurant.slug;
    await request(app).put('/api/restaurant').set(auth).send({ published: true, orderTypes: ['DINE_IN', 'TAKEAWAY'], taxPercent: 5, serviceChargePercent: 0 });
    for (const label of ['T1', 'T2', 'T3', 'T4']) await request(app).post('/api/tables').set(auth).send({ label, capacity: 4 });
    const cat = (await request(app).post('/api/categories').set(auth).send({ name: 'Mains' })).body.id;
    burger = (await request(app).post('/api/products').set(auth).send({ categoryId: cat, name: 'Burger', priceCents: 10000 })).body.id;
  });

  it('adds later items from the same table to the existing order, with correct totals', async () => {
    const first = await tableOrder('T1');
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ merged: false, totalCents: 10500 });
    const again = await tableOrder('T1', 2, 'Tia Friend');
    expect(again.status).toBe(201);
    expect(again.body).toMatchObject({ merged: true, number: first.body.number, trackingCode: first.body.trackingCode, totalCents: 31500 });
    const o = await byNumber(first.body.number);
    expect(o.items).toHaveLength(1); // the same dish becomes one bill line: 3 x Burger
    expect(o.items[0].quantity).toBe(3);
    expect(o).toMatchObject({ subtotalCents: 30000, taxCents: 1500, totalCents: 31500, status: 'NEW' });
    expect(o.items.every((i: any) => i.prepDone === false)).toBe(true);
    expect((await orders()).filter((x) => x.table?.label === 'T1')).toHaveLength(1);
  });

  it('keeps different dishes on separate lines and merges repeats, like a real bill', async () => {
    const cat = (await request(app).get(`/api/products`).set(auth)).body;
    const soup = (await request(app).post('/api/products').set(auth).send({ categoryId: (Array.isArray(cat) ? cat[0] : cat.products?.[0]).categoryId, name: 'Soup', priceCents: 17900 })).body.id;
    await request(app).post('/api/tables').set(auth).send({ label: 'T7', capacity: 2 });
    const one = await tableOrder('T7', 1);
    const more = await request(app).post(`/api/public/${slug}/orders`).send({ type: 'DINE_IN', tableLabel: 'T7', customerName: 'Tia Table', customerPhone: '+919300000001', items: [{ productId: soup, quantity: 3 }] });
    expect(more.body.merged).toBe(true);
    await tableOrder('T7', 1); // another burger: joins the burger line
    const o = await byNumber(one.body.number);
    expect(o.items.map((i: any) => [i.name, i.quantity]).sort()).toEqual([['Burger', 2], ['Soup', 3]]);
    expect(o.subtotalCents).toBe(2 * 10000 + 3 * 17900);
  });

  it('keeps other tables, takeaway and online orders separate', async () => {
    const a = await tableOrder('T2'), b = await tableOrder('T3');
    expect(a.body.number).not.toBe(b.body.number);
    const take = await request(app).post(`/api/public/${slug}/orders`).send({ type: 'TAKEAWAY', customerName: 'Tia Take', customerPhone: '+919300000001', items: [{ productId: burger, quantity: 1 }] });
    expect(take.body.merged).toBe(false);
    const t2 = await tableOrder('T2');
    expect(t2.body.number).toBe(a.body.number);
  });

  it('sends the order back to the kitchen as NEW when more is added after it was accepted or ready', async () => {
    const first = await tableOrder('T4');
    const o = await byNumber(first.body.number);
    for (const s of ['ACCEPTED', 'PREPARING', 'READY']) expect((await status(o.id, s)).status).toBe(200);
    const more = await tableOrder('T4');
    expect(more.body).toMatchObject({ merged: true, number: first.body.number });
    expect((await byNumber(first.body.number)).status).toBe('NEW');
    expect((await status((await byNumber(first.body.number)).id, 'ACCEPTED')).status).toBe(200); // the kitchen can accept the addition
    const track = await request(app).get(`/api/public/orders/track/${first.body.trackingCode}`);
    expect(track.body.history.map((h: any) => h.status)).toEqual(['NEW', 'ACCEPTED', 'PREPARING', 'READY', 'NEW', 'ACCEPTED']);
  });

  it('refuses to complete an order until it is paid, then completes it', async () => {
    const o = await byNumber((await tableOrder('T4')).body.number);
    for (const s of ['ACCEPTED', 'PREPARING', 'READY']) expect((await status(o.id, s)).status).toBe(200);
    const blocked = await status(o.id, 'SERVED');
    expect(blocked.status).toBe(200);
    const nope = await status(o.id, 'COMPLETED');
    expect(nope.status).toBe(409);
    expect(nope.body.error.code).toBe('payment_required');
    expect((await byNumber(o.number)).status).toBe('SERVED');
    expect((await pay(o.id)).status).toBe(200);
    expect((await status(o.id, 'COMPLETED')).status).toBe(200);
  });

  it('starts a new order once the previous one at the table is paid, completed or cancelled', async () => {
    const first = await tableOrder('T3'); // T3 already has an open unpaid order from above
    expect(first.body.merged).toBe(true);
    const o = await byNumber(first.body.number);
    expect((await pay(o.id)).status).toBe(200);
    const afterPay = await tableOrder('T3');
    expect(afterPay.body.merged).toBe(false);
    expect(afterPay.body.number).not.toBe(first.body.number);
    const o2 = await byNumber(afterPay.body.number);
    expect((await status(o2.id, 'CANCELLED')).status).toBe(200);
    expect((await tableOrder('T3')).body.merged).toBe(false);
  });

  it('lets kitchen staff accept, cook and ready an order, and waiters serve, take payment and complete it, each only within their role', async () => {
    const login = async (role: string) => {
      const email = `tbl-${role.toLowerCase()}-${uid}@example.com`;
      await request(app).post('/api/staff').set(auth).send({ name: role, email, password: 'Password123!', role });
      return { Authorization: `Bearer ${(await request(app).post('/api/auth/login').send({ email, password: 'Password123!' })).body.accessToken}` };
    };
    const kitchen = await login('KITCHEN');
    let waiter = await login('WAITER');
    await request(app).post('/api/tables').set(auth).send({ label: 'T8', capacity: 2 });
    const o = await byNumber((await tableOrder('T8')).body.number);
    const as = (h: Record<string, string>, st: string) => request(app).patch(`/api/orders/${o.id}/status`).set(h).send({ status: st });
    expect((await as(kitchen, 'SERVED')).status).toBe(403);
    expect((await as(kitchen, 'ACCEPTED')).status).toBe(200);
    expect((await as(kitchen, 'PREPARING')).status).toBe(200);
    expect((await as(kitchen, 'READY')).status).toBe(200);
    const no = await as(kitchen, 'COMPLETED');
    expect(no.status).toBe(403);
    expect(no.body.error.message).toMatch(/Kitchen accounts cannot/);
    // the owner can fix a wrongly assigned role, and it takes effect on the next request
    const staffList = (await request(app).get('/api/staff').set(auth)).body;
    const w = staffList.find((u: any) => u.role === 'WAITER');
    expect((await request(app).patch(`/api/staff/${w.id}`).set(auth).send({ role: 'OWNER' })).status).toBe(400);
    expect((await request(app).patch(`/api/staff/${w.id}`).set(auth).send({ role: 'KITCHEN' })).status).toBe(200);
    expect((await as(waiter, 'SERVED')).status).toBe(401); // the old pass is retired at once; they sign in again with the new role
    const again = await request(app).post('/api/auth/login').send({ email: `tbl-waiter-${uid}@example.com`, password: 'Password123!' });
    expect((await as({ Authorization: `Bearer ${again.body.accessToken}` }, 'SERVED')).status).toBe(403); // kitchen accounts cannot serve
    expect((await request(app).patch(`/api/staff/${w.id}`).set(auth).send({ role: 'WAITER' })).status).toBe(200);
    waiter = { Authorization: `Bearer ${(await request(app).post('/api/auth/login').send({ email: `tbl-waiter-${uid}@example.com`, password: 'Password123!' })).body.accessToken}` };
    expect((await as(waiter, 'SERVED')).status).toBe(200);
    // waiters watch New/Accepted/Preparing and cannot take them over; payment comes after serving
    const n = await byNumber((await tableOrder('T8')).body.number); // joins T8's bill, which goes back to NEW
    expect(n.status).toBe('NEW');
    expect((await request(app).patch(`/api/orders/${n.id}/status`).set(waiter).send({ status: 'ACCEPTED' })).status).toBe(403);
    expect((await request(app).patch(`/api/orders/${n.id}/payment`).set(waiter).send({ paymentStatus: 'PAID' })).status).toBe(409);
    for (const st of ['ACCEPTED', 'PREPARING', 'READY']) expect((await as(kitchen, st)).status).toBe(200);
    expect((await request(app).patch(`/api/orders/${n.id}/payment`).set(waiter).send({ paymentStatus: 'PAID' })).status).toBe(409); // dine-in, only ready
    expect((await as(waiter, 'SERVED')).status).toBe(200);
    expect((await request(app).patch(`/api/orders/${n.id}/payment`).set(waiter).send({ paymentStatus: 'PAID' })).status).toBe(200);
    expect((await as(waiter, 'COMPLETED')).status).toBe(200);
  });

  it('puts simultaneous orders from one table on a single bill', async () => {
    await request(app).post('/api/tables').set(auth).send({ label: 'T9', capacity: 2 });
    const rs = await Promise.all([1, 2, 3, 4].map(() => tableOrder('T9')));
    expect(rs.every((r) => r.status === 201)).toBe(true);
    expect(new Set(rs.map((r) => r.body.number)).size).toBe(1);
    const o = await byNumber(rs[0].body.number);
    expect(o.items).toHaveLength(1);
    expect(o.items[0].quantity).toBe(4);
    expect(o.totalCents).toBe(42000);
  });
});
