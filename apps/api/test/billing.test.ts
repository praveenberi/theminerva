import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcryptjs';
import request from 'supertest';

process.env.ENABLE_TEST_PAYMENTS = '1';
process.env.PAYMENT_PROVIDER = 'test';

import { createApp } from '../src/app';
import { prisma } from '../src/lib/core';
import { addMonths, runBilling } from '../src/lib/billing';
import { signTestEvent } from '../src/lib/payments';

const app = createApp();
const uid = Date.now().toString(36);
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const DAY = 86_400_000;

async function signup(tag: string, planCode?: string) {
  const r = await request(app).post('/api/auth/register').send({ restaurantName: `Bill ${tag} ${uid}`, name: 'Owner', email: `bill-${tag}-${uid}@example.com`, password: 'Password123!', planCode });
  expect(r.status).toBe(201);
  const restaurant = await prisma.restaurant.findUniqueOrThrow({ where: { id: r.body.restaurant.id } });
  return { token: r.body.accessToken as string, auth: bearer(r.body.accessToken), tenantId: restaurant.tenantId, restaurantId: restaurant.id, slug: restaurant.slug };
}
type Biz = Awaited<ReturnType<typeof signup>>;

const ent = async (b: Biz) => (await request(app).get('/api/entitlements').set(b.auth)).body;
const billing = async (b: Biz) => (await request(app).get('/api/billing').set(b.auth)).body;
const sub = (b: Biz) => prisma.subscription.findUniqueOrThrow({ where: { tenantId: b.tenantId }, include: { plan: true } });
/** pays an invoice through the dev provider's real webhook path */
async function pay(b: Biz, invoiceId: string) {
  const r = await request(app).post(`/api/billing/invoices/${invoiceId}/pay`).set(b.auth);
  expect(r.status).toBe(200);
  const id = (r.body.payUrl as string).split('/').pop();
  return request(app).post(`/api/public/payments/test/${id}`).send({ outcome: 'paid' });
}

describe('date maths', () => {
  it('adds months without overflowing short months', () => {
    expect(addMonths(new Date('2026-01-31T00:00:00Z'), 1).toISOString().slice(0, 10)).toBe('2026-02-28');
    expect(addMonths(new Date('2028-01-31T00:00:00Z'), 1).toISOString().slice(0, 10)).toBe('2028-02-29');
    expect(addMonths(new Date('2026-11-15T00:00:00Z'), 12).toISOString().slice(0, 10)).toBe('2027-11-15');
  });
});

describe('subscriptions', () => {
  let adminToken: string;
  const plans: Record<string, any> = {};

  beforeAll(async () => {
    await prisma.user.create({ data: { email: `bill-admin-${uid}@example.com`, name: 'Admin', role: 'SUPER_ADMIN', passwordHash: await bcrypt.hash('Password123!', 10) } });
    adminToken = (await request(app).post('/api/auth/login').send({ email: `bill-admin-${uid}@example.com`, password: 'Password123!' })).body.accessToken;
    for (const p of (await request(app).get('/api/public/plans')).body) plans[p.code] = p;
  });
  const admin = () => bearer(adminToken);

  describe('plans and trials', () => {
    it('serves plans and prices from the database, so admin edits show up everywhere', async () => {
      expect(Object.keys(plans)).toEqual(expect.arrayContaining(['STARTER', 'GROWTH', 'PRO', 'ENTERPRISE']));
      const code = `T${uid}`.toUpperCase();
      const body = { code, name: 'Test plan', description: '', priceCents: 12345, currency: 'INR', intervalMonths: 1, trialDays: 3, limits: { maxOutlets: 1, maxStaff: 1, maxProducts: 2 }, features: ['crm'], active: true, sort: 90 };
      expect((await request(app).post('/api/admin/plans').set(admin()).send(body)).status).toBe(201);
      expect((await request(app).post('/api/admin/plans').set(admin()).send(body)).status).toBe(409);
      expect((await request(app).post('/api/admin/plans').set(admin()).send({ ...body, code: 'BAD1', features: ['teleport'] })).status).toBe(400);
      const created = (await request(app).get('/api/public/plans')).body.find((p: any) => p.code === code);
      expect(created).toMatchObject({ priceCents: 12345, trialDays: 3, features: ['crm'], limits: { maxStaff: 1, maxProducts: 2 } });
      const edited = await request(app).put(`/api/admin/plans/${created.id}`).set(admin()).send({ ...body, priceCents: 22222 });
      expect(edited.body.priceCents).toBe(22222);
      expect((await request(app).get('/api/public/plans')).body.find((p: any) => p.code === code).priceCents).toBe(22222);
      expect((await request(app).post('/api/admin/plans').set(bearer((await signup('np')).token)).send(body)).status).toBe(403); // owners cannot edit plans
      plans.TEST = created;
    });

    it('starts every new business on a full-access trial of the chosen plan', async () => {
      const b = await signup('trial', 'pro');
      const e = await ent(b);
      expect(e).toMatchObject({ status: 'TRIALING', trial: true, operational: true, planName: 'Pro' });
      expect(e.daysLeft).toBe(14);
      expect(e.features).toEqual(expect.arrayContaining(['inventory', 'marketing', 'multi_outlet']));
      const unknown = await signup('trial2', 'nonsense'); // falls back to the default plan instead of failing registration
      expect((await ent(unknown)).planName).toBe('Growth');
    });
  });

  describe('buying, upgrading, downgrading', () => {
    let b: Biz;
    beforeAll(async () => { b = await signup('life'); });

    it('invoices the plan, activates only after a verified payment, and ignores replays and wrong amounts', async () => {
      const r = await request(app).post('/api/billing/change').set(b.auth).send({ planCode: 'growth' });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ result: 'invoice', amountCents: plans.GROWTH.priceCents });
      expect(r.body.payUrl).toMatch(/\/pay\/test\//);
      expect((await sub(b)).status).toBe('TRIALING'); // asking is not paying

      const open = (await billing(b)).invoices[0];
      expect(open).toMatchObject({ status: 'OPEN', kind: 'NEW', amountCents: plans.GROWTH.priceCents });
      const payId = r.body.payUrl.split('/').pop();
      const forged = { eventId: `x-${uid}`, kind: 'paid', providerRef: `test_${payId}`, amountCents: 1 };
      const raw = JSON.stringify(forged);
      expect((await request(app).post('/api/payments/webhook/test').set('content-type', 'application/json').set('x-test-signature', 'bad').send(raw)).status).toBe(400);
      expect((await request(app).post('/api/payments/webhook/test').set('content-type', 'application/json').set('x-test-signature', signTestEvent(raw)).send(raw)).body.result).toBe('ignored'); // wrong amount
      expect((await sub(b)).status).toBe('TRIALING');

      expect((await pay(b, open.id)).body.result).toBe('applied');
      const s = await sub(b);
      expect(s).toMatchObject({ status: 'ACTIVE', cancelAtPeriodEnd: false });
      expect(s.plan.code).toBe('GROWTH');
      expect(Math.round((s.currentPeriodEnd.getTime() - s.currentPeriodStart.getTime()) / DAY)).toBeGreaterThanOrEqual(28);
      expect((await billing(b)).invoices[0].status).toBe('PAID');
      expect((await request(app).post(`/api/billing/invoices/${open.id}/pay`).set(b.auth)).status).toBe(409); // invoice is closed now
      expect((await prisma.tenant.findUniqueOrThrow({ where: { id: b.tenantId } })).plan).toBe('GROWTH');
    });

    it('enforces what the plan includes, on the server', async () => {
      expect((await request(app).get('/api/customers').set(b.auth)).status).toBe(200); // crm: included in Growth
      expect((await request(app).get('/api/coupons').set(b.auth)).status).toBe(200); // promotions
      const inv = await request(app).get('/api/ingredients').set(b.auth);
      expect(inv.status).toBe(402);
      expect(inv.body.error.code).toBe('plan_required');
      expect(inv.body.error.message).toContain('Growth');
      expect((await request(app).get('/api/campaigns').set(b.auth)).status).toBe(402); // marketing: Pro
      expect((await request(app).post('/api/outlets').set(b.auth).send({ name: 'Second place' })).body.error.code).toBe('plan_required'); // multi-outlet
    });

    it('charges an upgrade prorated for the rest of the period and switches only when paid', async () => {
      const s = await sub(b);
      const half = new Date(Date.now() + 15 * DAY);
      await prisma.subscription.update({ where: { id: s.id }, data: { currentPeriodStart: new Date(half.getTime() - 30 * DAY), currentPeriodEnd: half } });
      const r = await request(app).post('/api/billing/change').set(b.auth).send({ planCode: 'PRO' });
      expect(r.body.result).toBe('invoice');
      const expected = Math.round((plans.PRO.priceCents - plans.GROWTH.priceCents) * 0.5);
      expect(Math.abs(r.body.amountCents - expected)).toBeLessThanOrEqual(Math.round(plans.PRO.priceCents / 1000) + 5); // half of the remaining month
      expect((await ent(b)).planName).toBe('Growth'); // not yet
      expect((await request(app).get('/api/ingredients').set(b.auth)).status).toBe(402);
      await pay(b, (await billing(b)).invoices[0].id);
      const after = await sub(b);
      expect(after.plan.code).toBe('PRO');
      expect(after.currentPeriodEnd.getTime()).toBe(half.getTime()); // upgrades keep the paid period
      expect((await request(app).get('/api/ingredients').set(b.auth)).status).toBe(200); // inventory unlocked
      expect((await request(app).get('/api/campaigns').set(b.auth)).status).toBe(200);
    });

    it('schedules a downgrade for renewal, bills the new plan then, and never double-invoices', async () => {
      const r = await request(app).post('/api/billing/change').set(b.auth).send({ planCode: 'GROWTH' });
      expect(r.body.result).toBe('scheduled');
      expect((await ent(b)).planName).toBe('Pro'); // keeps what it paid for until the period ends
      expect((await billing(b)).subscription.pendingPlan.code).toBe('GROWTH');
      // changing your mind cancels the downgrade
      expect((await request(app).post('/api/billing/change').set(b.auth).send({ planCode: 'PRO' })).body.result).toBe('unscheduled');
      expect((await billing(b)).subscription.pendingPlan).toBeNull();
      await request(app).post('/api/billing/change').set(b.auth).send({ planCode: 'GROWTH' });

      const s = await sub(b);
      const after = new Date(s.currentPeriodEnd.getTime() + 60_000);
      await runBilling(after, b.tenantId);
      await runBilling(after, b.tenantId); // second run must change nothing
      const state = await billing(b);
      expect(state.subscription.status).toBe('PAST_DUE');
      const renewals = state.invoices.filter((i: any) => i.kind === 'RENEWAL');
      expect(renewals).toHaveLength(1);
      expect(renewals[0]).toMatchObject({ status: 'OPEN', amountCents: plans.GROWTH.priceCents, plan: 'Growth' });
      expect((await request(app).get('/api/customers').set(b.auth)).status).toBe(200); // grace: still working

      await pay(b, renewals[0].id);
      const renewed = await sub(b);
      expect(renewed).toMatchObject({ status: 'ACTIVE', pendingPlanId: null });
      expect(renewed.plan.code).toBe('GROWTH');
      expect(renewed.currentPeriodStart.getTime()).toBe(s.currentPeriodEnd.getTime()); // no gap, no overlap
      expect(renewed.currentPeriodEnd.getTime()).toBe(addMonths(s.currentPeriodEnd, 1).getTime());
      expect((await request(app).get('/api/ingredients').set(b.auth)).status).toBe(402);
    });
  });

  describe('non-payment, expiry and winning customers back', () => {
    let b: Biz, productId: string;
    beforeAll(async () => {
      b = await signup('lapse');
      const cat = await request(app).post('/api/categories').set(b.auth).send({ name: 'Mains' });
      productId = (await request(app).post('/api/products').set(b.auth).send({ categoryId: cat.body.id, name: 'Curry', priceCents: 10000 })).body.id;
      await request(app).put('/api/restaurant').set(b.auth).send({ published: true, orderTypes: ['TAKEAWAY'], taxPercent: 0 });
    });
    const order = () => request(app).post(`/api/public/${b.slug}/orders`).send({ type: 'TAKEAWAY', customerName: 'Late Larry', customerPhone: '+919300000001', items: [{ productId, quantity: 1 }] });

    it('bills at the end of the trial, gives a grace period, then expires and voids the invoice', async () => {
      expect((await order()).status).toBe(201);
      const s = await sub(b);
      const trialEnd = s.trialEndsAt!;
      expect((await runBilling(new Date(trialEnd.getTime() - 1000), b.tenantId)).invoiced).toBe(0); // not yet
      await runBilling(new Date(trialEnd.getTime() + 1000), b.tenantId);
      let state = await billing(b);
      expect(state.subscription.status).toBe('PAST_DUE');
      expect(state.invoices[0]).toMatchObject({ status: 'OPEN', kind: 'NEW' });
      expect((await order()).status).toBe(201); // still serving during grace

      await runBilling(new Date(trialEnd.getTime() + 8 * DAY), b.tenantId);
      state = await billing(b);
      expect(state.subscription.status).toBe('EXPIRED');
      expect(state.invoices[0].status).toBe('VOID');
      expect(state.entitlements.operational).toBe(false);
    });

    it('stops taking new orders and gated features, but never traps staff or in-flight orders', async () => {
      const blocked = await order();
      expect(blocked.status).toBe(503);
      expect(blocked.body.error.code).toBe('unavailable');
      expect((await request(app).get(`/api/public/${b.slug}`)).body.restaurant).toMatchObject({ acceptingOrders: false }); // storefront still browsable
      expect((await request(app).get('/api/customers').set(b.auth)).body.error.code).toBe('subscription_inactive');
      expect((await request(app).post('/api/products').set(b.auth).send({ categoryId: 'x', name: 'n', priceCents: 1 })).body.error.code).toBe('subscription_inactive');
      const list = await request(app).get('/api/orders').set(b.auth);
      expect(list.status).toBe(200); // staff can still see and finish orders
      const o = list.body.items[0];
      for (const st of ['ACCEPTED', 'PREPARING', 'READY', 'COMPLETED']) expect((await request(app).patch(`/api/orders/${o.id}/status`).set(b.auth).send({ status: st })).status).toBe(200);
      expect((await request(app).get('/api/billing').set(b.auth)).status).toBe(200); // and can always reach billing to pay
    });

    it('comes back after paying a new invoice', async () => {
      const r = await request(app).post('/api/billing/change').set(b.auth).send({ planCode: 'GROWTH' });
      expect(r.body.result).toBe('invoice');
      await pay(b, (await billing(b)).invoices[0].id);
      expect((await ent(b))).toMatchObject({ status: 'ACTIVE', operational: true, planName: 'Growth' });
      expect((await order()).status).toBe(201);
    });
  });

  describe('cancelling', () => {
    it('keeps access until the period ends, can be undone, and then ends without an invoice', async () => {
      const b = await signup('cancel');
      await pay(b, (await request(app).post('/api/billing/change').set(b.auth).send({ planCode: 'STARTER' }).then(async () => (await billing(b)).invoices[0].id)));
      expect((await sub(b)).status).toBe('ACTIVE');
      expect((await request(app).post('/api/billing/cancel').set(b.auth)).status).toBe(200);
      expect((await ent(b)).cancelAtPeriodEnd).toBe(true);
      expect((await ent(b)).operational).toBe(true);
      expect((await request(app).post('/api/billing/resume').set(b.auth)).status).toBe(200);
      expect((await ent(b)).cancelAtPeriodEnd).toBe(false);
      await request(app).post('/api/billing/cancel').set(b.auth);
      const end = (await sub(b)).currentPeriodEnd;
      const run = await runBilling(new Date(end.getTime() + 1000), b.tenantId);
      expect(run).toMatchObject({ canceled: 1, invoiced: 0 });
      const s = await sub(b);
      expect(s.status).toBe('CANCELED');
      expect(await prisma.invoice.count({ where: { tenantId: b.tenantId, status: 'OPEN' } })).toBe(0);
      expect((await request(app).post('/api/billing/resume').set(b.auth)).status).toBe(409); // already ended
    });

    it('lets a trial be cancelled so it simply expires', async () => {
      const b = await signup('cancel2');
      await request(app).post('/api/billing/cancel').set(b.auth);
      const run = await runBilling(new Date((await sub(b)).trialEndsAt!.getTime() + 1000), b.tenantId);
      expect(run.expired).toBe(1);
      expect((await sub(b)).status).toBe('EXPIRED');
    });
  });

  describe('limits and isolation', () => {
    it('enforces plan limits for staff and menu items, and keeps other plans out of reach', async () => {
      const b = await signup('limits');
      const code = plans.TEST.code as string; // 1 staff, 2 menu items, crm only
      await request(app).patch(`/api/admin/subscriptions/${b.tenantId}`).set(admin()).send({ planCode: code, status: 'ACTIVE' });
      expect((await ent(b))).toMatchObject({ planName: 'Test plan', trial: false });
      const cat = await request(app).post('/api/categories').set(b.auth).send({ name: 'Mains' });
      const add = (n: number) => request(app).post('/api/products').set(b.auth).send({ categoryId: cat.body.id, name: `Item ${n}`, priceCents: 100 });
      expect((await add(1)).status).toBe(201);
      expect((await add(2)).status).toBe(201);
      const third = await add(3);
      expect(third.status).toBe(402);
      expect(third.body.error.code).toBe('limit_reached');
      const first = (await request(app).get('/api/products').set(b.auth)).body[0].id;
      expect((await request(app).post(`/api/products/${first}/duplicate`).set(b.auth)).status).toBe(402);
      expect((await request(app).post('/api/menu/import').set(b.auth).send({ csv: 'category,name,description,price,available\nMains,Extra,,1.00,true' })).status).toBe(402);

      const staff = (n: number) => request(app).post('/api/staff').set(b.auth).send({ name: `Staffer ${n}`, email: `bill-s${n}-${uid}@example.com`, password: 'Password123!', role: 'WAITER' });
      const s1 = await staff(1);
      expect(s1.status).toBe(201);
      expect((await staff(2)).body.error.code).toBe('limit_reached');
      await request(app).patch(`/api/staff/${s1.body.id}`).set(b.auth).send({ active: false });
      expect((await staff(2)).status).toBe(201); // deactivating frees a seat
      expect((await request(app).patch(`/api/staff/${s1.body.id}`).set(b.auth).send({ active: true })).status).toBe(402); // reactivating would exceed it

      // features outside the plan stay shut, including settings that would enable them
      expect((await request(app).put('/api/restaurant').set(b.auth).send({ onlinePayments: true })).status).toBe(402);
      expect((await request(app).get('/api/coupons').set(b.auth)).status).toBe(402);
      await request(app).put('/api/restaurant').set(b.auth).send({ published: true });
      expect((await request(app).get(`/api/public/${b.slug}/availability?date=2030-01-01&partySize=2`)).status).toBe(404); // no reservations on this plan
      expect((await request(app).get(`/api/public/${b.slug}`)).body.restaurant).toMatchObject({ reservations: false, onlinePayments: false, loyalty: null });
    });

    it("keeps one business's billing away from another, and away from staff", async () => {
      const a = await signup('iso-a'), c = await signup('iso-c');
      await request(app).post('/api/billing/change').set(a.auth).send({ planCode: 'GROWTH' });
      const inv = (await billing(a)).invoices[0];
      expect((await request(app).post(`/api/billing/invoices/${inv.id}/pay`).set(c.auth)).status).toBe(404);
      await request(app).post('/api/staff').set(a.auth).send({ name: 'Wendy Waiter', email: `bill-w-${uid}@example.com`, password: 'Password123!', role: 'WAITER' });
      const w = bearer((await request(app).post('/api/auth/login').send({ email: `bill-w-${uid}@example.com`, password: 'Password123!' })).body.accessToken);
      expect((await request(app).get('/api/billing').set(w)).status).toBe(403);
      expect((await request(app).post('/api/billing/change').set(w).send({ planCode: 'PRO' })).status).toBe(403);
      expect((await request(app).get('/api/entitlements').set(w)).status).toBe(200); // but they can see what their plan allows
      expect((await request(app).get('/api/admin/subscriptions').set(a.auth)).status).toBe(403);
    });

    it('lets the super admin comp, extend and reinstate accounts, and run the billing job', async () => {
      const b = await signup('adm');
      await request(app).post('/api/billing/cancel').set(b.auth);
      await runBilling(new Date((await sub(b)).trialEndsAt!.getTime() + 1000), b.tenantId);
      expect((await ent(b)).operational).toBe(false);
      const r = await request(app).patch(`/api/admin/subscriptions/${b.tenantId}`).set(admin()).send({ extendDays: 10 });
      expect(r.status).toBe(200);
      expect((await ent(b))).toMatchObject({ operational: true, status: 'ACTIVE' });
      const list = (await request(app).get('/api/admin/subscriptions').set(admin())).body;
      expect(list.find((s: any) => s.tenantId === b.tenantId)).toMatchObject({ status: 'ACTIVE' });
      expect((await request(app).post('/api/admin/billing/run').set(admin())).status).toBe(200);
    });
  });

  afterAll(async () => {
    if (plans.TEST) await request(app).put(`/api/admin/plans/${plans.TEST.id}`).set(admin()).send({ ...plans.TEST, active: false, limits: plans.TEST.limits }); // keep the shared dev database tidy
  });
});
