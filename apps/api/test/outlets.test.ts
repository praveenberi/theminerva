import { describe, expect, it, beforeAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';
import { prisma } from '../src/lib/core';

const app = createApp();
const uid = Date.now().toString(36);
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

describe('multi-outlet', () => {
  const agent = request.agent(app); // keeps the refresh cookie like a browser
  let tenantId: string, token: string, outletA: { id: string; slug: string };
  let outletB: { id: string; slug: string; name: string };
  let other: { token: string; outletId: string };
  let productA: string;

  const orderAt = (slug: string, phone: string, productId: string, name = 'Cross Outlet') =>
    request(app).post(`/api/public/${slug}/orders`).send({ type: 'TAKEAWAY', customerName: name, customerPhone: phone, items: [{ productId, quantity: 1 }] });

  beforeAll(async () => {
    const r = await agent.post('/api/auth/register').send({ restaurantName: `Brand ${uid}`, name: 'Owner', email: `mo-${uid}@example.com`, password: 'Password123!' });
    token = r.body.accessToken; outletA = { id: r.body.restaurant.id, slug: r.body.restaurant.slug };
    tenantId = (await prisma.restaurant.findUniqueOrThrow({ where: { id: outletA.id } })).tenantId;
    const cat = await request(app).post('/api/categories').set(bearer(token)).send({ name: 'Mains' });
    productA = (await request(app).post('/api/products').set(bearer(token)).send({ categoryId: cat.body.id, name: 'Curry', priceCents: 20000 })).body.id;
    await request(app).put('/api/restaurant').set(bearer(token)).send({ published: true, orderTypes: ['TAKEAWAY'], taxPercent: 0 });

    const o = await request(app).post('/api/auth/register').send({ restaurantName: `Other ${uid}`, name: 'Other', email: `mo-other-${uid}@example.com`, password: 'Password123!' });
    other = { token: o.body.accessToken, outletId: o.body.restaurant.id };
  });

  it('enforces the per-tenant outlet limit, even under concurrent requests', async () => {
    const list = await request(app).get('/api/outlets').set(bearer(token));
    expect(list.body).toMatchObject({ maxOutlets: 1, canAdd: false });
    const denied = await request(app).post('/api/outlets').set(bearer(token)).send({ name: 'Second' });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('outlet_limit');

    await prisma.tenant.update({ where: { id: tenantId }, data: { maxOutlets: 2 } }); // what a super admin would do
    const race = await Promise.all([1, 2, 3].map((n) => request(app).post('/api/outlets').set(bearer(token)).send({ name: `Branch ${uid} ${n}`, address: 'Elsewhere', copyMenuFrom: outletA.id })));
    expect(race.filter((x) => x.status === 201)).toHaveLength(1); // only one slot was free
    expect(race.filter((x) => x.status === 403)).toHaveLength(2);
    outletB = race.find((x) => x.status === 201)!.body;
    await prisma.tenant.update({ where: { id: tenantId }, data: { maxOutlets: 3 } });
  });

  it('copies the menu as an independent set with its own prices', async () => {
    await request(app).put('/api/restaurant').set(bearer(token)); // no-op, keeps outlet A selected
    const sw = await request(app).post('/api/auth/switch-outlet').set(bearer(token)).send({ restaurantId: outletB.id });
    expect(sw.status).toBe(200);
    const tokenB = sw.body.accessToken;
    const prodsB = (await request(app).get('/api/products').set(bearer(tokenB))).body;
    expect(prodsB.map((p: any) => [p.name, p.priceCents])).toEqual([['Curry', 20000]]);
    expect(prodsB[0].id).not.toBe(productA);

    await request(app).put(`/api/products/${prodsB[0].id}`).set(bearer(tokenB)).send({ categoryId: prodsB[0].categoryId, name: 'Curry', priceCents: 25000 });
    expect((await request(app).get('/api/products').set(bearer(token))).body[0].priceCents).toBe(20000); // A untouched
    expect((await request(app).get('/api/products').set(bearer(tokenB))).body[0].priceCents).toBe(25000);
  });

  it('isolates outlets: orders, and cross-tenant switching is refused', async () => {
    await request(app).put('/api/restaurant').set(bearer(token)).send({ published: true });
    const tokenB = (await request(app).post('/api/auth/switch-outlet').set(bearer(token)).send({ restaurantId: outletB.id })).body.accessToken;
    await request(app).put('/api/restaurant').set(bearer(tokenB)).send({ published: true, orderTypes: ['TAKEAWAY'], taxPercent: 0 });
    const prodB = (await request(app).get('/api/products').set(bearer(tokenB))).body[0].id;

    expect((await orderAt(outletA.slug, '+919000010001', productA)).status).toBe(201);
    expect((await orderAt(outletB.slug, '+919000010001', prodB)).status).toBe(201);
    expect((await orderAt(outletB.slug, '+919000010002', prodB, 'Only B')).status).toBe(201);
    expect((await orderAt(outletA.slug, '+919000010003', prodB)).status).toBe(400); // B's product id is not valid at A

    expect((await request(app).get('/api/orders').set(bearer(token))).body.total).toBe(1);
    expect((await request(app).get('/api/orders').set(bearer(tokenB))).body.total).toBe(2);

    expect((await request(app).post('/api/auth/switch-outlet').set(bearer(token)).send({ restaurantId: other.outletId })).status).toBe(404);
    expect((await request(app).post('/api/auth/switch-outlet').set(bearer(other.token)).send({ restaurantId: outletA.id })).status).toBe(404);
  });

  it('remembers the selected outlet across token refreshes', async () => {
    await agent.post('/api/auth/switch-outlet').set(bearer(token)).send({ restaurantId: outletB.id });
    const refreshed = await agent.post('/api/auth/refresh');
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.restaurant.id).toBe(outletB.id);
    const back = await agent.post('/api/auth/switch-outlet').set(bearer(refreshed.body.accessToken)).send({ restaurantId: outletA.id });
    expect(back.status).toBe(200);
    expect((await agent.post('/api/auth/refresh')).body.restaurant.id).toBe(outletA.id);
  });

  it('pins staff to their assigned outlet and keeps them out of the others', async () => {
    const staffRes = await request(app).post('/api/staff').set(bearer(token)).send({ name: 'Wendy Waiter', email: `mo-w-${uid}@example.com`, password: 'Password123!', role: 'WAITER', restaurantId: outletB.id });
    expect(staffRes.status).toBe(201);
    expect((await request(app).post('/api/staff').set(bearer(token)).send({ name: 'Bad Assign', email: `mo-x-${uid}@example.com`, password: 'Password123!', role: 'WAITER', restaurantId: other.outletId })).status).toBe(400);

    const login = await request(app).post('/api/auth/login').send({ email: `mo-w-${uid}@example.com`, password: 'Password123!' });
    expect(login.body.restaurant.id).toBe(outletB.id);
    const w = bearer(login.body.accessToken);
    expect((await request(app).get('/api/orders').set(w)).body.total).toBe(2); // sees B's orders only
    expect((await request(app).post('/api/auth/switch-outlet').set(w).send({ restaurantId: outletA.id })).status).toBe(403);
    const mine = await request(app).get('/api/outlets').set(w);
    expect(mine.body.outlets.map((o: any) => o.id)).toEqual([outletB.id]);
    expect((await request(app).get('/api/outlets/compare').set(w)).status).toBe(403);

    // reassigning moves them; their next login lands in the new outlet
    await request(app).patch(`/api/staff/${staffRes.body.id}`).set(bearer(token)).send({ restaurantId: outletA.id });
    const again = await request(app).post('/api/auth/login').send({ email: `mo-w-${uid}@example.com`, password: 'Password123!' });
    expect(again.body.restaurant.id).toBe(outletA.id);
  });

  it('compares outlets and merges customers across them', async () => {
    const cmp = await request(app).get('/api/outlets/compare?range=today').set(bearer(token));
    expect(cmp.status).toBe(200);
    const byId = Object.fromEntries(cmp.body.outlets.map((o: any) => [o.id, o]));
    expect(byId[outletA.id]).toMatchObject({ orders: 1, revenueCents: 20000 });
    expect(byId[outletB.id]).toMatchObject({ orders: 2, revenueCents: 50000 }); // B's own, higher price
    expect(cmp.body).toMatchObject({ totalOrders: 3, totalRevenueCents: 70000 });
    expect(JSON.stringify(cmp.body)).not.toContain(other.outletId);

    const cust = (await request(app).get('/api/outlets/customers').set(bearer(token))).body;
    const both = cust.find((c: any) => c.phone === '+919000010001');
    expect(both).toMatchObject({ outlets: 2, orders: 2, spent: 45000 }); // one profile, two outlets
    expect(cust.find((c: any) => c.phone === '+919000010002')).toMatchObject({ outlets: 1, name: 'Only B' });
    expect((await request(app).get('/api/outlets/customers').set(bearer(other.token))).body).toEqual([]);
  });
});
