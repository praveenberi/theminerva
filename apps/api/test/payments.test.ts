import { describe, expect, it, beforeAll } from 'vitest';
import crypto from 'node:crypto';
import request from 'supertest';

process.env.ENABLE_TEST_PAYMENTS = '1';
process.env.STRIPE_SECRET_KEY = 'sk_test_x';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
process.env.RAZORPAY_KEY_ID = 'rzp_test';
process.env.RAZORPAY_KEY_SECRET = 'secret';
process.env.RAZORPAY_WEBHOOK_SECRET = 'rzp_whsec';
process.env.PAYMENT_PROVIDER = 'test';

import { createApp } from '../src/app';
import { configuredAdapters, signTestEvent } from '../src/lib/payments';

const app = createApp();
const uid = Date.now().toString(36);

describe('webhook signature verification', () => {
  const stripe = configuredAdapters().stripe;
  const body = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed', data: { object: { id: 'cs_1', payment_status: 'paid', payment_intent: 'pi_1', amount_total: 500 } } });
  const sign = (t: number, secret = 'whsec_test') => `t=${t},v1=${crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
  const now = () => Math.floor(Date.now() / 1000);

  it('stripe: accepts a valid signature and returns a normalized event', () => {
    expect(stripe.parseWebhook(Buffer.from(body), { 'stripe-signature': sign(now()) })).toMatchObject({ kind: 'paid', providerRef: 'cs_1', amountCents: 500 });
  });
  it('stripe: rejects wrong secret, tampered body and stale timestamps', () => {
    expect(() => stripe.parseWebhook(Buffer.from(body), { 'stripe-signature': sign(now(), 'other') })).toThrow(/signature/);
    expect(() => stripe.parseWebhook(Buffer.from(body + ' '), { 'stripe-signature': sign(now()) })).toThrow(/signature/);
    expect(() => stripe.parseWebhook(Buffer.from(body), { 'stripe-signature': sign(now() - 3600) })).toThrow(/signature/);
    expect(() => stripe.parseWebhook(Buffer.from(body), {})).toThrow(/signature/);
  });
  it('razorpay: verifies HMAC of the raw body', () => {
    const rz = configuredAdapters().razorpay;
    const b = JSON.stringify({ event: 'payment_link.paid', payload: { payment_link: { entity: { id: 'plink_1', amount_paid: 900 } }, payment: { entity: { id: 'pay_1' } } } });
    const sig = crypto.createHmac('sha256', 'rzp_whsec').update(b).digest('hex');
    expect(rz.parseWebhook(Buffer.from(b), { 'x-razorpay-signature': sig, 'x-razorpay-event-id': 'e1' })).toMatchObject({ kind: 'paid', providerRef: 'plink_1', providerPaymentId: 'pay_1', amountCents: 900 });
    expect(() => rz.parseWebhook(Buffer.from(b), { 'x-razorpay-signature': 'bad', 'x-razorpay-event-id': 'e1' })).toThrow(/signature/);
  });
});

async function signup(tag: string) {
  const r = await request(app).post('/api/auth/register').send({ restaurantName: `Pay ${tag} ${uid}`, name: 'Owner', email: `pay-${tag}-${uid}@example.com`, password: 'Password123!' });
  return { slug: r.body.restaurant.slug as string, auth: { Authorization: `Bearer ${r.body.accessToken}` } };
}

describe('online payment flow', () => {
  let a: Awaited<ReturnType<typeof signup>>, b: Awaited<ReturnType<typeof signup>>, productId: string;

  beforeAll(async () => {
    a = await signup('a'); b = await signup('b');
    const cat = await request(app).post('/api/categories').set(a.auth).send({ name: 'Mains' });
    productId = (await request(app).post('/api/products').set(a.auth).send({ categoryId: cat.body.id, name: 'Curry', priceCents: 20000 })).body.id;
    await request(app).put('/api/restaurant').set(a.auth).send({ published: true, taxPercent: 0, serviceChargePercent: 0, orderTypes: ['TAKEAWAY'] });
    await request(app).post('/api/coupons').set(a.auth).send({ code: 'ONCE', type: 'FIXED', value: 1000, usageLimit: 1 });
  });

  const place = (extra: object = {}) => request(app).post(`/api/public/${a.slug}/orders`).send({
    type: 'TAKEAWAY', customerName: 'Pat Payer', customerPhone: '+919999911111', paymentMethod: 'ONLINE', items: [{ productId, quantity: 1 }], ...extra,
  });
  let webhookToken = ''; // each restaurant has its own webhook URL
  const webhook = (obj: object, sig?: string) => {
    const raw = JSON.stringify(obj);
    return request(app).post(`/api/payments/webhook/test/${webhookToken}`).set('content-type', 'application/json').set('x-test-signature', sig ?? signTestEvent(raw)).send(raw);
  };
  const trackOf = async (code: string) => (await request(app).get(`/api/public/orders/track/${code}`)).body;
  const activeOrders = async () => (await request(app).get('/api/orders?active=1').set(a.auth)).body.items;
  const findOrder = async (code: string) => (await request(app).get('/api/orders?q=Pat').set(a.auth)).body.items.find((x: any) => x.trackingCode === code);

  it('refuses online payment until the restaurant connects its own account and enables it', async () => {
    expect((await place()).status).toBe(400);
    const early = await request(app).put('/api/restaurant').set(a.auth).send({ onlinePayments: true });
    expect(early.status).toBe(409); // nothing to take money with yet
    expect(early.body.error.code).toBe('no_payment_account');
    const conn = await request(app).put('/api/payment-account').set(a.auth).send({ provider: 'test', secrets: {} });
    expect(conn.status).toBe(200);
    webhookToken = conn.body.account.webhookUrl.split('/').pop();
    expect((await request(app).put('/api/restaurant').set(a.auth).send({ onlinePayments: true })).status).toBe(200);
    expect((await request(app).get(`/api/public/${a.slug}`)).body.restaurant.onlinePayments).toBe(true);
  });

  it('holds the order as PENDING_PAYMENT, hidden from kitchen and revenue, until a verified webhook arrives', async () => {
    const o = await place();
    expect(o.status).toBe(201);
    expect(o.body.payUrl).toMatch(/\/pay\/test\//);
    expect((await trackOf(o.body.trackingCode)).status).toBe('PENDING_PAYMENT');
    expect((await activeOrders()).some((x: any) => x.trackingCode === o.body.trackingCode)).toBe(false);
    expect((await request(app).get('/api/dashboard').set(a.auth)).body.revenueCents).toBe(0);

    const payId = o.body.payUrl.split('/').pop();
    expect((await request(app).get(`/api/public/payments/test/${payId}`)).body.amountCents).toBe(20000);

    const forged = { eventId: 'evil', kind: 'paid', providerRef: `test_${payId}`, amountCents: 20000 };
    expect((await webhook(forged, 'deadbeef')).status).toBe(400);
    expect((await trackOf(o.body.trackingCode)).status).toBe('PENDING_PAYMENT');

    const wrong = await webhook({ ...forged, eventId: `wrong-amt-${uid}`, amountCents: 1 });
    expect(wrong.body.result).toBe('ignored');
    expect((await trackOf(o.body.trackingCode)).status).toBe('PENDING_PAYMENT');

    expect((await request(app).post(`/api/public/payments/test/${payId}`).send({ outcome: 'paid' })).body.result).toBe('applied');
    expect((await request(app).post(`/api/public/payments/test/${payId}`).send({ outcome: 'paid' })).body.result).toBe('duplicate');
    const t = await trackOf(o.body.trackingCode);
    expect(t).toMatchObject({ status: 'NEW', paymentStatus: 'PAID' });
    expect(t.history.map((h: any) => h.status)).toEqual(['PENDING_PAYMENT', 'NEW']);
    expect((await activeOrders()).some((x: any) => x.trackingCode === o.body.trackingCode)).toBe(true);
    expect((await request(app).get('/api/dashboard').set(a.auth)).body.revenueCents).toBe(20000);
  });

  it('cancels the order and returns the coupon when payment fails', async () => {
    const o = await place({ couponCode: 'ONCE' });
    expect(o.status).toBe(201);
    expect((await place({ couponCode: 'ONCE' })).status).toBe(400); // the single use is held by the pending order
    const payId = o.body.payUrl.split('/').pop();
    await request(app).post(`/api/public/payments/test/${payId}`).send({ outcome: 'failed' });
    expect((await trackOf(o.body.trackingCode)).status).toBe('CANCELLED');
    expect((await place({ couponCode: 'ONCE' })).status).toBe(201); // released
  });

  it('refunds partially, never beyond the paid amount, even concurrently', async () => {
    const o = await place();
    const payId = o.body.payUrl.split('/').pop();
    await request(app).post(`/api/public/payments/test/${payId}`).send({ outcome: 'paid' });
    const order = await findOrder(o.body.trackingCode);
    const refund = (amountCents?: number, h = a.auth) => request(app).post('/api/payments/refund').set(h).send({ orderId: order.id, amountCents });

    expect((await refund(5000, b.auth)).status).toBe(404); // other tenant
    expect((await refund(5000)).body).toMatchObject({ amountCents: 5000, paymentStatus: 'PARTIALLY_REFUNDED' });
    expect((await refund(15001)).status).toBe(400);
    const race = await Promise.all([refund(15000), refund(15000), refund(15000)]);
    expect(race.filter((r) => r.status === 201)).toHaveLength(1);
    expect((await trackOf(o.body.trackingCode)).paymentStatus).toBe('REFUNDED');
    expect((await refund(1)).status).toBe(400);
  });

  it('does not let staff hand-mark online orders as paid', async () => {
    const o = await place();
    const order = await findOrder(o.body.trackingCode);
    expect((await request(app).patch(`/api/orders/${order.id}/payment`).set(a.auth).send({ paymentStatus: 'PAID' })).status).toBe(409);
  });
});
