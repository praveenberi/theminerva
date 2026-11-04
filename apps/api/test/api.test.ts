import { describe, expect, it, beforeAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';
import { computeTotals, canTransition } from '../src/lib/pricing';

const app = createApp();
const uid = Date.now().toString(36);

describe('pricing', () => {
  const cfg = { taxPercent: 5, serviceChargePercent: 10, deliveryFeeCents: 4000, isDelivery: false };
  it('applies discount before tax and service charge', () => {
    const t = computeTotals(10000, cfg, { type: 'PERCENT', value: 10, minSubtotalCents: 0 }, 500);
    expect(t).toMatchObject({ discountCents: 1000, taxCents: 450, serviceCents: 900, tipCents: 500, totalCents: 9000 + 450 + 900 + 500 });
  });
  it('ignores a coupon below its minimum and never discounts below zero', () => {
    expect(computeTotals(1000, cfg, { type: 'FIXED', value: 500, minSubtotalCents: 2000 }).discountCents).toBe(0);
    expect(computeTotals(1000, cfg, { type: 'FIXED', value: 5000, minSubtotalCents: 0 }).discountCents).toBe(1000);
  });
  it('adds delivery fee only for delivery', () => {
    expect(computeTotals(1000, { ...cfg, isDelivery: true }, null).deliveryCents).toBe(4000);
  });
  it('enforces the status workflow', () => {
    expect(canTransition('NEW', 'ACCEPTED')).toBe(true);
    expect(canTransition('NEW', 'COMPLETED')).toBe(false);
    expect(canTransition('COMPLETED', 'CANCELLED')).toBe(false);
  });
});

async function signup(tag: string) {
  const r = await request(app).post('/api/auth/register').send({
    restaurantName: `Test ${tag} ${uid}`, name: 'Owner', email: `${tag}-${uid}@example.com`, password: 'Password123!',
  });
  expect(r.status).toBe(201);
  return { token: r.body.accessToken as string, slug: r.body.restaurant.slug as string, auth: { Authorization: `Bearer ${r.body.accessToken}` } };
}

describe('registration & auth', () => {
  it('rejects bad input and duplicate emails, and logs in', async () => {
    const bad = await request(app).post('/api/auth/register').send({ email: 'x', password: '1' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('validation');
    await signup('auth');
    const dup = await request(app).post('/api/auth/register').send({ restaurantName: 'Again', name: 'Oscar', email: `auth-${uid}@example.com`, password: 'Password123!' });
    expect(dup.status).toBe(409);
    expect((await request(app).post('/api/auth/login').send({ email: `auth-${uid}@example.com`, password: 'wrong-pass' })).status).toBe(401);
    const ok = await request(app).post('/api/auth/login').send({ email: `auth-${uid}@example.com`, password: 'Password123!' });
    expect(ok.status).toBe(200);
    expect(ok.headers['set-cookie'][0]).toMatch(/HttpOnly/);
  });
  it('requires a token on protected routes', async () => {
    expect((await request(app).get('/api/products')).status).toBe(401);
  });
});

describe('storefront order flow & tenant isolation', () => {
  let a: Awaited<ReturnType<typeof signup>>, b: Awaited<ReturnType<typeof signup>>;
  let productId: string, tableId: string;

  beforeAll(async () => {
    a = await signup('a'); b = await signup('b');
    const cat = await request(app).post('/api/categories').set(a.auth).send({ name: 'Mains' });
    const p = await request(app).post('/api/products').set(a.auth).send({
      categoryId: cat.body.id, name: 'Pasta', priceCents: 20000, variants: [{ id: 'l', name: 'Large', priceCents: 5000 }],
    });
    expect(p.status).toBe(201);
    productId = p.body.id;
    const t = await request(app).post('/api/tables').set(a.auth).send({ label: 'T1', capacity: 4 });
    tableId = t.body.id;
    await request(app).put('/api/restaurant').set(a.auth).send({ published: true, orderTypes: ['DINE_IN', 'TAKEAWAY'], taxPercent: 5, serviceChargePercent: 0 });
    await request(app).post('/api/coupons').set(a.auth).send({ code: 'SAVE', type: 'FIXED', value: 1000, usageLimit: 1 });
  });

  it('hides unpublished storefronts', async () => {
    expect((await request(app).get(`/api/public/${b.slug}`)).status).toBe(404);
    expect((await request(app).get(`/api/public/${a.slug}`)).status).toBe(200);
  });

  const order = (extra = {}) => request(app).post(`/api/public/${a.slug}/orders`).send({
    type: 'TAKEAWAY', customerName: 'Sam Guest', customerPhone: '+919999900000',
    items: [{ productId, quantity: 2, variantId: 'l' }], ...extra,
  });

  it('prices on the server, requires a variant, and ignores client totals', async () => {
    expect((await order({ items: [{ productId, quantity: 1 }] })).status).toBe(400);
    const r = await order({ totalCents: 1 });
    expect(r.status).toBe(201);
    expect(r.body.totalCents).toBe(Math.round(50000 * 1.05)); // 2 × (200 + 50), 5% tax
  });

  it('redeems a limited coupon only once', async () => {
    const first = await order({ couponCode: 'save' });
    expect(first.status).toBe(201);
    expect(first.body.totalCents).toBe(Math.round(49000 * 1.05));
    expect((await order({ couponCode: 'SAVE' })).status).toBe(400);
  });

  it('requires a valid table for dine-in', async () => {
    expect((await order({ type: 'DINE_IN', tableLabel: 'nope' })).status).toBe(400);
    expect((await order({ type: 'DINE_IN', tableLabel: 'T1' })).status).toBe(201);
  });

  it('moves an order through the workflow with role limits and awards loyalty', async () => {
    const placed = await order();
    const list = await request(app).get('/api/orders?q=Sam').set(a.auth);
    const o = list.body.items.find((x: any) => x.trackingCode === placed.body.trackingCode);
    const patch = (s: string, h = a.auth) => request(app).patch(`/api/orders/${o.id}/status`).set(h).send({ status: s });
    expect((await patch('COMPLETED')).status).toBe(409);
    for (const s of ['ACCEPTED', 'PREPARING', 'READY']) expect((await patch(s)).status).toBe(200);
    expect((await patch('COMPLETED')).status).toBe(200);
    expect((await patch('CANCELLED')).status).toBe(409);
    const track = await request(app).get(`/api/public/orders/track/${placed.body.trackingCode}`);
    expect(track.body.status).toBe('COMPLETED');
    expect(track.body.history.map((h: any) => h.status)).toEqual(['NEW', 'ACCEPTED', 'PREPARING', 'READY', 'COMPLETED']);
    const cust = await request(app).get('/api/customers').set(a.auth);
    expect(cust.body[0].loyaltyPoints).toBeGreaterThan(0);
  });

  it('keeps tenants isolated', async () => {
    const orders = await request(app).get('/api/orders').set(b.auth);
    expect(orders.body.total).toBe(0);
    expect((await request(app).get('/api/products').set(b.auth)).body).toEqual([]);
    expect((await request(app).put(`/api/products/${productId}`).set(b.auth).send({ categoryId: 'x', name: 'Hack', priceCents: 1 })).status).toBe(400);
    expect((await request(app).delete(`/api/products/${productId}`).set(b.auth)).status).toBe(404);
    expect((await request(app).delete(`/api/tables/${tableId}`).set(b.auth)).status).toBe(404);
  });

  it('enforces role permissions', async () => {
    const mk = await request(app).post('/api/staff').set(a.auth).send({ name: 'Kay Kitchen', email: `k-${uid}@example.com`, password: 'Password123!', role: 'KITCHEN' });
    expect(mk.status).toBe(201);
    const login = await request(app).post('/api/auth/login').send({ email: `k-${uid}@example.com`, password: 'Password123!' });
    const k = { Authorization: `Bearer ${login.body.accessToken}` };
    expect((await request(app).post('/api/products').set(k).send({})).status).toBe(403);
    expect((await request(app).get('/api/dashboard').set(k)).status).toBe(403);
    expect((await request(app).get('/api/admin/restaurants').set(a.auth)).status).toBe(403);
  });

  it('prevents double booking under concurrency', async () => {
    const start = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const book = (n: number) => request(app).post(`/api/public/${a.slug}/reservations`).send({ name: `Guest ${n}`, phone: '+919999900001', partySize: 2, startsAt: start });
    const results = await Promise.all([1, 2, 3, 4].map(book));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1); // only one table exists
    expect(results.filter((r) => r.status === 409)).toHaveLength(3);
  });

  it('reports dashboard figures from real orders', async () => {
    const d = await request(app).get('/api/dashboard?range=today').set(a.auth);
    expect(d.status).toBe(200);
    expect(d.body.orders).toBeGreaterThanOrEqual(4);
    expect(d.body.revenueCents).toBeGreaterThan(0);
    expect(d.body.topProducts[0].name).toBe('Pasta');
  });
});
