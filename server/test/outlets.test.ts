import { beforeAll, describe, expect, it } from 'vitest';
import { api, login, prisma, productBySlug } from './helpers.js';

let admin: Awaited<ReturnType<typeof login>>;
let manager: Awaited<ReturnType<typeof login>>;
let kitchen: Awaited<ReturnType<typeof login>>;
let a: any, b: any;

beforeAll(async () => {
  admin = await login('admin@theminerva.com');
  manager = await login('manager@theminerva.com');
  kitchen = await login('kitchen@theminerva.com');
});

describe('multi-outlet', () => {
  it('only the owner manages branches; branches are hidden publicly until enabled', async () => {
    expect((await api().post('/api/outlets').set(manager.auth).send({ name: 'X', code: 'XX' })).status).toBe(403);
    a = (await api().post('/api/outlets').set(admin.auth).send({ name: 'Marina', code: 'MRN' })).body;
    b = (await api().post('/api/outlets').set(admin.auth).send({ name: 'Orchard', code: 'ORC' })).body;
    expect(a.id).toBeTruthy();
    expect((await api().post('/api/outlets').set(admin.auth).send({ name: 'Dup', code: 'MRN' })).status).toBe(409);
    expect((await api().get('/api/public/outlets')).body).toEqual([]); // multiOutlet off → single-outlet site
  });

  it('requires a branch once enabled and applies branch prices / availability', async () => {
    await api().put('/api/restaurant/settings').set(admin.auth).send({ site: { multiOutlet: true } });
    expect((await api().get('/api/public/outlets')).body).toHaveLength(2);
    const soup = await productBySlug('tomato-soup'); // 8.00
    const items = [{ productId: soup.id, quantity: 1 }];
    const guest = { name: 'G', phone: '+65 9333 0000' };
    expect((await api().post('/api/orders').send({ type: 'TAKEAWAY', guest, items })).status).toBe(400); // no branch chosen

    const set = await api().put(`/api/outlets/${a.id}/products/${soup.id}`).set(manager.auth).send({ price: 10, isAvailable: true });
    expect(set.status).toBe(200);
    expect((await api().post('/api/orders/quote').send({ type: 'TAKEAWAY', items, outletId: a.id })).body.subtotal).toBe(10);
    expect((await api().post('/api/orders/quote').send({ type: 'TAKEAWAY', items, outletId: b.id })).body.subtotal).toBe(8);
    const menu = await api().get(`/api/public/menu?outletId=${a.id}`);
    const soupA = menu.body.flatMap((m: any) => m.categories.flatMap((c: any) => c.products)).find((p: any) => p.id === soup.id);
    expect(Number(soupA.price)).toBe(10);

    await api().put(`/api/outlets/${b.id}/products/${soup.id}`).set(manager.auth).send({ price: null, isAvailable: false });
    expect((await api().post('/api/orders/quote').send({ type: 'TAKEAWAY', items, outletId: b.id })).status).toBe(400);
    const menuB = await api().get(`/api/public/menu?outletId=${b.id}`);
    expect(menuB.body.flatMap((m: any) => m.categories.flatMap((c: any) => c.products)).some((p: any) => p.id === soup.id)).toBe(false);
    // resetting removes the override
    await api().put(`/api/outlets/${b.id}/products/${soup.id}`).set(manager.auth).send({ price: null, isAvailable: true });
    expect(await prisma.outletProduct.count({ where: { outletId: b.id } })).toBe(0);
  });

  it('scopes staff assigned to a branch and compares branches for head office', async () => {
    const soup = await productBySlug('tomato-soup');
    const place = async (outletId: string) => {
      const o = await api().post('/api/orders').send({ type: 'TAKEAWAY', outletId, guest: { name: 'G', phone: '+65 9333 1111' }, items: [{ productId: soup.id, quantity: 1 }] });
      expect(o.status).toBe(201);
      for (const s of ['ACCEPTED', 'PREPARING', 'READY', 'COMPLETED']) await api().patch(`/api/orders/${o.body.id}/status`).set(manager.auth).send({ status: s });
      return o.body;
    };
    const oa = await place(a.id);
    await place(b.id);
    await place(b.id);
    const cmp = await api().get('/api/reports/outlets/compare?range=last30').set(admin.auth);
    const byName = Object.fromEntries(cmp.body.branches.map((x: any) => [x.branch, x]));
    expect(byName.Marina.orders).toBe(1);
    expect(byName.Orchard.orders).toBe(2);

    // dashboard filter
    const dash = await api().get(`/api/reports/dashboard?range=last30&outletId=${b.id}`).set(admin.auth);
    expect(dash.body.kpis.completedOrders).toBe(2);

    // kitchen staff pinned to Marina only sees Marina's orders
    const k = await prisma.user.findUniqueOrThrow({ where: { email: 'kitchen@theminerva.com' } });
    await prisma.user.update({ where: { id: k.id }, data: { outletId: a.id } });
    const list = await api().get('/api/orders?pageSize=100').set(kitchen.auth);
    expect(list.body.items.every((o: any) => o.outletId === a.id)).toBe(true);
    expect(list.body.items.some((o: any) => o.id === oa.id)).toBe(true);
    expect((await api().get('/api/reports/outlets/compare').set(kitchen.auth)).status).toBe(403);
    await prisma.user.update({ where: { id: k.id }, data: { outletId: null } });
  });

  it('table orders inherit the table branch', async () => {
    const t = await prisma.diningTable.update({ where: { label: 'T4' }, data: { outletId: b.id } });
    const soup = await productBySlug('tomato-soup');
    const o = await api().post('/api/orders').send({ type: 'DINE_IN', tableToken: t.qrToken, guest: { name: 'T4' , phone: '+65 9333 2222' }, items: [{ productId: soup.id, quantity: 1 }] });
    expect(o.status).toBe(201);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.body.id } })).outletId).toBe(b.id);
  });

  it('deactivates instead of deleting a branch that has orders', async () => {
    const r = await api().delete(`/api/outlets/${a.id}`).set(admin.auth);
    expect(r.body.deactivated).toBe(true);
    await api().put('/api/restaurant/settings').set(admin.auth).send({ site: { multiOutlet: false } });
  });
});

describe('dine-in without a QR code', () => {
  it('lets a customer pick a table number, and rejects unknown tables', async () => {
    const soup = await productBySlug('tomato-soup');
    const base = { type: 'DINE_IN', guest: { name: 'Walk In', phone: '+65 9444 0000' }, items: [{ productId: soup.id, quantity: 1 }] };
    expect((await api().get('/api/public/tables')).body.length).toBeGreaterThan(0);
    expect((await api().post('/api/orders').send(base)).status).toBe(400); // no table
    expect((await api().post('/api/orders').send({ ...base, tableLabel: 'NOPE' })).status).toBe(400);
    const ok = await api().post('/api/orders').send({ ...base, tableLabel: 'T5' });
    expect(ok.status).toBe(201);
    const o = await prisma.order.findUniqueOrThrow({ where: { id: ok.body.id } });
    expect(o.type).toBe('DINE_IN');
    expect(o.tableId).toBeTruthy();
  });
});

describe('table visit with several orders', () => {
  it('reuses contact details from the open order and merges the orders in tracking', async () => {
    const t = await prisma.diningTable.findUniqueOrThrow({ where: { label: 'T2' } });
    const soup = await productBySlug('tomato-soup');
    const body = (extra: object = {}) => ({ type: 'DINE_IN', tableToken: t.qrToken, items: [{ productId: soup.id, quantity: 1 }], ...extra });
    // nobody has ordered yet: contact is still required
    expect((await api().post('/api/orders').send(body())).status).toBe(400);
    const first = await api().post('/api/orders').send(body({ guest: { name: 'Dana', phone: '+65 9555 1234' } }));
    expect(first.status).toBe(201);

    const info = await api().get(`/api/public/table/${t.qrToken}`);
    expect(info.body.knownGuest.name).toBe('Dana');
    expect(info.body.knownGuest.phoneMasked).not.toContain('9555');
    expect(info.body.knownGuest.phoneMasked).toMatch(/34$/);

    const second = await api().post('/api/orders').send(body()); // no contact supplied
    expect(second.status).toBe(201);
    const row = await prisma.order.findUniqueOrThrow({ where: { id: second.body.id } });
    expect(row.guestPhone).toBe('+65 9555 1234');
    expect(row.guestName).toBe('Dana');

    for (const token of [first.body.trackingToken, second.body.trackingToken]) {
      const tr = await api().get(`/api/public/orders/${token}`);
      expect(tr.body.group.orders).toHaveLength(2);
      expect(tr.body.group.tableLabel).toBe('T2');
      expect(Number(tr.body.group.total)).toBeCloseTo(Number(first.body.total) + Number(second.body.total), 2);
      expect(JSON.stringify(tr.body)).not.toContain('9555');
    }
    expect((await api().get(`/api/public/orders/${first.body.trackingToken}`)).body.group.thisOrder).toBe(first.body.number);
  });
});

describe('completed orders leave the table view', () => {
  it('shows only open orders in the merged table page', async () => {
    const t = await prisma.diningTable.create({ data: { label: 'TX9', capacity: 2 } });
    const soup = await productBySlug('tomato-soup');
    const mk = async () => (await api().post('/api/orders').send({ type: 'DINE_IN', tableToken: t.qrToken, guest: { name: 'Eli', phone: '+65 9666 7777' }, items: [{ productId: soup.id, quantity: 1 }] })).body;
    const a = await mk(); const b = await mk(); const c = await mk();
    const finish = async (id: string) => { for (const s of ['ACCEPTED', 'PREPARING', 'READY', 'SERVED', 'COMPLETED']) await api().patch(`/api/orders/${id}/status`).set(manager.auth).send({ status: s }); };
    await finish(a.id);
    const view = await api().get(`/api/public/orders/${b.trackingToken}`);
    expect(view.body.group.orders.map((o: any) => o.number)).toEqual([b.number, c.number]);
    expect(Number(view.body.group.total)).toBeCloseTo(Number(b.total) + Number(c.total), 2);
    // the completed order's own link still works and shows the remaining open orders
    expect((await api().get(`/api/public/orders/${a.trackingToken}`)).body.group.orders).toHaveLength(2);
    await finish(b.id);
    // only one open order left → plain single-order page
    expect((await api().get(`/api/public/orders/${c.trackingToken}`)).body.group).toBeNull();
    await finish(c.id);
    const done = await api().get(`/api/public/orders/${c.trackingToken}`);
    expect(done.body.group).toBeNull();
    expect(done.body.status).toBe('COMPLETED');
  });
});
