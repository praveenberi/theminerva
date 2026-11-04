import { describe, expect, it, beforeAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';

const app = createApp();
const uid = Date.now().toString(36);

async function signup(tag: string) {
  const r = await request(app).post('/api/auth/register').send({ restaurantName: `Kit ${tag} ${uid}`, name: 'Owner', email: `kit-${tag}-${uid}@example.com`, password: 'Password123!' });
  return { slug: r.body.restaurant.slug as string, auth: { Authorization: `Bearer ${r.body.accessToken}` } };
}
async function staffLogin(owner: { auth: object }, role: string, tag: string) {
  const email = `kit-${tag}-${role}-${uid}@example.com`;
  await request(app).post('/api/staff').set(owner.auth).send({ name: `${role} person`, email, password: 'Password123!', role });
  const l = await request(app).post('/api/auth/login').send({ email, password: 'Password123!' });
  return { Authorization: `Bearer ${l.body.accessToken}` };
}

describe('kitchen display', () => {
  let a: Awaited<ReturnType<typeof signup>>, b: Awaited<ReturnType<typeof signup>>, kitchenAuth: { Authorization: string };
  let productId: string, orderId: string, itemIds: string[];

  beforeAll(async () => {
    a = await signup('a'); b = await signup('b');
    kitchenAuth = await staffLogin(a, 'KITCHEN', 'a');
    const cat = await request(app).post('/api/categories').set(a.auth).send({ name: 'Food' });
    productId = (await request(app).post('/api/products').set(a.auth).send({ categoryId: cat.body.id, name: 'Burger', priceCents: 20000, prepMinutes: 25 })).body.id;
    const p2 = (await request(app).post('/api/products').set(a.auth).send({ categoryId: cat.body.id, name: 'Fries', priceCents: 8000, prepMinutes: 8 })).body.id;
    await request(app).put('/api/restaurant').set(a.auth).send({ published: true, orderTypes: ['TAKEAWAY'], taxPercent: 0 });
    const placed = await request(app).post(`/api/public/${a.slug}/orders`).send({
      type: 'TAKEAWAY', customerName: 'Kit Chen', customerPhone: '+919000000010', notes: 'allergic to nuts',
      items: [{ productId, quantity: 2 }, { productId: p2, quantity: 1, notes: 'extra salt' }],
    });
    orderId = (await request(app).get('/api/orders?q=Kit').set(a.auth)).body.items.find((o: any) => o.trackingCode === placed.body.trackingCode).id;
  });

  const patch = (s: string, h = kitchenAuth) => request(app).patch(`/api/orders/${orderId}/status`).set(h).send({ status: s });

  it('feeds the kitchen screen with items, notes and a target time from the slowest dish', async () => {
    const kds = await request(app).get('/api/kds').set(kitchenAuth);
    expect(kds.status).toBe(200);
    const o = kds.body.orders.find((x: any) => x.id === orderId);
    expect(o).toMatchObject({ status: 'NEW', notes: 'allergic to nuts', targetMinutes: 25 });
    expect(o.items.map((i: any) => [i.name, i.quantity, i.done])).toEqual([['Burger', 2, false], ['Fries', 1, false]]);
    itemIds = o.items.map((i: any) => i.id);
  });

  it('only lets items be ticked while the order is being prepared', async () => {
    const tick = (i: number, done: boolean) => request(app).patch(`/api/orders/${orderId}/items/${itemIds[i]}`).set(kitchenAuth).send({ done });
    expect((await tick(0, true)).status).toBe(409); // still NEW
    expect((await patch('ACCEPTED')).status).toBe(200);
    expect((await patch('PREPARING')).status).toBe(200);
    expect((await tick(0, true)).status).toBe(200);
    const o = (await request(app).get('/api/kds').set(kitchenAuth)).body.orders.find((x: any) => x.id === orderId);
    expect(o.items.map((i: any) => i.done)).toEqual([true, false]);
    expect((await patch('READY')).status).toBe(200);
    expect((await tick(1, true)).status).toBe(409); // READY: locked
  });

  it('keeps kitchen staff out of other restaurants and non-kitchen routes', async () => {
    expect((await request(app).get('/api/kds').set(b.auth)).body.orders).toEqual([]);
    expect((await request(app).patch(`/api/orders/${orderId}/items/${itemIds[0]}`).set(b.auth).send({ done: false })).status).toBe(409);
    expect((await request(app).get('/api/kds')).status).toBe(401);
    expect((await patch('COMPLETED')).status).toBe(403); // kitchen cannot complete
  });

  it('reports prep time from accepted to ready', async () => {
    const s = await request(app).get('/api/kds/stats').set(kitchenAuth);
    expect(s.body.readyToday).toBe(1);
    expect(s.body.avgPrepMinutes).toBeGreaterThanOrEqual(0);
    expect(s.body.avgPrepMinutes).toBeLessThan(1);
    expect((await request(app).get('/api/kds/stats').set(b.auth)).body.readyToday).toBe(0);
  });
});

describe('delivery', () => {
  let a: Awaited<ReturnType<typeof signup>>, b: Awaited<ReturnType<typeof signup>>;
  let productId: string, near: string, far: string, riderId: string;

  beforeAll(async () => {
    a = await signup('da'); b = await signup('db');
    const cat = await request(app).post('/api/categories').set(a.auth).send({ name: 'Food' });
    productId = (await request(app).post('/api/products').set(a.auth).send({ categoryId: cat.body.id, name: 'Thali', priceCents: 15000 })).body.id;
    await request(app).put('/api/restaurant').set(a.auth).send({ published: true, orderTypes: ['DELIVERY'], taxPercent: 0, deliveryFeeCents: 999, minDeliveryCents: 0 });
  });

  const place = (extra: object = {}, qty = 1) => request(app).post(`/api/public/${a.slug}/orders`).send({
    type: 'DELIVERY', customerName: 'Dee Livery', customerPhone: '+919000000020', address: '12 Lane', items: [{ productId, quantity: qty }], ...extra,
  });

  it('falls back to the flat fee when no zones exist', async () => {
    expect((await place()).body.totalCents).toBe(15000 + 999);
  });

  it('prices by zone: fee, minimum and ETA are chosen server-side', async () => {
    near = (await request(app).post('/api/delivery/zones').set(a.auth).send({ name: 'Within 3 km', feeCents: 2000, minOrderCents: 10000, etaMinutes: 30 })).body.id;
    far = (await request(app).post('/api/delivery/zones').set(a.auth).send({ name: '3-8 km', feeCents: 6000, minOrderCents: 40000, etaMinutes: 60 })).body.id;
    expect((await request(app).post('/api/delivery/zones').set(a.auth).send({ name: 'Within 3 km', feeCents: 1 })).status).toBe(409);
    expect((await place()).status).toBe(400); // must choose a zone now
    expect((await place({ zoneId: 'bogus' })).status).toBe(400);
    const ok = await place({ zoneId: near });
    expect(ok.body.totalCents).toBe(15000 + 2000);
    expect((await place({ zoneId: far })).status).toBe(400); // 150 < 400 minimum
    expect((await place({ zoneId: far }, 3)).body.totalCents).toBe(45000 + 6000);
    const track = await request(app).get(`/api/public/orders/track/${ok.body.trackingCode}`);
    expect(new Date(track.body.etaAt).getTime() - Date.now()).toBeGreaterThan(29 * 60_000 - 5000);
    const menu = await request(app).get(`/api/public/${a.slug}`);
    expect(menu.body.restaurant.deliveryZones.map((z: any) => z.name)).toEqual(['Within 3 km', '3-8 km']);
    await request(app).patch(`/api/delivery/zones/${far}`).set(a.auth).send({ active: false });
    expect((await place({ zoneId: far }, 3)).status).toBe(400); // disabled zones are refused
  });

  it('requires an assigned partner before the order goes out, and only reveals the rider then', async () => {
    riderId = (await request(app).post('/api/delivery/partners').set(a.auth).send({ name: 'Ravi', phone: '+919111111111' })).body.id;
    const o = await place({ zoneId: near });
    const order = (await request(app).get('/api/orders?q=Dee').set(a.auth)).body.items.find((x: any) => x.trackingCode === o.body.trackingCode);
    const st = (s: string) => request(app).patch(`/api/orders/${order.id}/status`).set(a.auth).send({ status: s });
    for (const s of ['ACCEPTED', 'PREPARING', 'READY']) await st(s);
    expect((await st('OUT_FOR_DELIVERY')).body.error.code).toBe('partner_required');

    expect((await request(app).patch(`/api/orders/${order.id}/delivery`).set(a.auth).send({ partnerId: 'nope' })).status).toBe(400);
    expect((await request(app).patch(`/api/orders/${order.id}/delivery`).set(b.auth).send({ partnerId: riderId })).status).toBe(400); // b cannot use a's rider
    const bRider = (await request(app).post('/api/delivery/partners').set(b.auth).send({ name: 'Bob', phone: '+919222222222' })).body.id;
    expect((await request(app).patch(`/api/orders/${order.id}/delivery`).set(b.auth).send({ partnerId: bRider })).status).toBe(409); // nor touch a's order
    expect((await request(app).patch(`/api/orders/${order.id}/delivery`).set(a.auth).send({ partnerId: riderId })).status).toBe(200);
    let t = await request(app).get(`/api/public/orders/track/${o.body.trackingCode}`);
    expect(t.body.rider).toBeNull(); // assigned but not yet dispatched
    expect((await st('OUT_FOR_DELIVERY')).status).toBe(200);
    t = await request(app).get(`/api/public/orders/track/${o.body.trackingCode}`);
    expect(t.body.rider).toEqual({ name: 'Ravi', phone: '+919111111111' });
    expect((await st('COMPLETED')).status).toBe(200);
  });

  it("does not let another restaurant use or see this restaurant's partners and zones", async () => {
    expect((await request(app).get('/api/delivery/partners').set(b.auth)).body.map((p: any) => p.name)).toEqual(['Bob']); // never 'Ravi'
    expect((await request(app).get('/api/delivery/zones').set(b.auth)).body).toEqual([]);
    expect((await request(app).patch(`/api/delivery/zones/${near}`).set(b.auth).send({ feeCents: 0 })).status).toBe(404);
    const o = await request(app).post(`/api/public/${a.slug}/orders`).send({ type: 'DELIVERY', customerName: 'X Y', customerPhone: '+919000000021', address: 'a', zoneId: far, items: [{ productId, quantity: 3 }] });
    expect(o.status).toBe(400);
  });
});
