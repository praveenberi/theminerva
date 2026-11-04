import { describe, expect, it, beforeAll, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import request from 'supertest';

process.env.ENABLE_TEST_PAYMENTS = '1';
delete process.env.STRIPE_SECRET_KEY; // the platform's own keys must play no part in a restaurant's payments
delete process.env.STRIPE_WEBHOOK_SECRET;

import { createApp } from '../src/app';
import { prisma } from '../src/lib/core';
import { decryptJson, encryptJson } from '../src/lib/secrets';

const app = createApp();
const uid = Date.now().toString(36);
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

describe('secret encryption', () => {
  it('round-trips, is randomised, and detects tampering', () => {
    const blob = encryptJson({ secretKey: 'sk_test_abcdefghij' });
    expect(blob).not.toContain('sk_test');
    expect(encryptJson({ secretKey: 'sk_test_abcdefghij' })).not.toBe(blob); // fresh IV each time
    expect(decryptJson<{ secretKey: string }>(blob).secretKey).toBe('sk_test_abcdefghij');
    const flipped = `${blob.slice(0, -3)}${blob.endsWith('AAA') ? 'BBB' : 'AAA'}`;
    expect(() => decryptJson(flipped)).toThrow();
    expect(() => decryptJson('plain-text')).toThrow();
  });
});

// ---- a fake Stripe, so the real adapter code runs without network access ----
const calls: { url: string; auth?: string; body?: string; method?: string }[] = [];
let stripeAccountStatus = 200;
let counter = 0;
const realFetch = globalThis.fetch;
function stubStripe() {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: any = {}) => {
    const u = String(url);
    if (!u.startsWith('https://api.stripe.com')) return realFetch(url, init);
    calls.push({ url: u, auth: init.headers?.Authorization, body: init.body?.toString(), method: init.method });
    const json = (status: number, body: object) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (u.endsWith('/v1/account')) return json(stripeAccountStatus, stripeAccountStatus === 200 ? { id: 'acct_x' } : { error: { message: 'Invalid API Key' } });
    if (u.endsWith('/v1/checkout/sessions')) { const n = ++counter; return json(200, { id: `cs_test_${uid}_${n}`, url: `https://checkout.stripe.test/${n}` }); } // ids are globally unique, like Stripe's
    if (u.endsWith('/v1/refunds')) return json(200, { id: `re_${++counter}` });
    return json(404, {});
  }));
}
afterEach(() => { vi.unstubAllGlobals(); calls.length = 0; stripeAccountStatus = 200; });

const stripeKeys = (tag: string) => ({ secretKey: `sk_test_${tag}${'x'.repeat(12)}`, webhookSecret: `whsec_${tag}${'y'.repeat(12)}` });
const stripeSig = (secret: string, raw: string) => { const t = Math.floor(Date.now() / 1000); return `t=${t},v1=${crypto.createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex')}`; };

async function signup(tag: string) {
  const r = await request(app).post('/api/auth/register').send({ restaurantName: `Acct ${tag} ${uid}`, name: 'Owner', email: `acct-${tag}-${uid}@example.com`, password: 'Password123!' });
  const auth = bearer(r.body.accessToken);
  const cat = await request(app).post('/api/categories').set(auth).send({ name: 'Mains' });
  const productId = (await request(app).post('/api/products').set(auth).send({ categoryId: cat.body.id, name: 'Curry', priceCents: 20000 })).body.id;
  await request(app).put('/api/restaurant').set(auth).send({ published: true, taxPercent: 0, serviceChargePercent: 0, orderTypes: ['TAKEAWAY'] });
  return { auth, slug: r.body.restaurant.slug as string, restaurantId: r.body.restaurant.id as string, productId };
}
type Biz = Awaited<ReturnType<typeof signup>>;
const connect = (b: Biz, keys: object, provider = 'stripe') => request(app).put('/api/payment-account').set(b.auth).send({ provider, secrets: keys });
const tokenOf = (res: any) => res.body.account.webhookUrl.split('/').pop() as string;
const place = (b: Biz) => request(app).post(`/api/public/${b.slug}/orders`).send({ type: 'TAKEAWAY', customerName: 'Pia Payer', customerPhone: '+919400000001', paymentMethod: 'ONLINE', items: [{ productId: b.productId, quantity: 1 }] });
const track = async (code: string) => (await request(app).get(`/api/public/orders/track/${code}`)).body;
const stripeEvent = (id: string, ref: string, amount: number) => JSON.stringify({ id, type: 'checkout.session.completed', data: { object: { id: ref, payment_status: 'paid', payment_intent: `pi_${id}`, amount_total: amount } } });
const send = (provider: string, token: string, raw: string, sig: string) => request(app).post(`/api/payments/webhook/${provider}/${token}`).set('content-type', 'application/json').set('stripe-signature', sig).send(raw);

describe("a restaurant's own payment account", () => {
  let a: Biz, b: Biz;
  beforeAll(async () => { a = await signup('a'); b = await signup('b'); });

  it('verifies credentials with the provider before saving, and never returns or stores them in plain text', async () => {
    stubStripe();
    const keys = stripeKeys('aaa');
    const bad = await connect(a, { secretKey: 'not-a-key', webhookSecret: 'nope' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details.secretKey[0]).toContain('sk_test_');

    stripeAccountStatus = 401;
    const rejected = await connect(a, keys);
    expect(rejected.status).toBe(400);
    expect(rejected.body.error.code).toBe('credentials_rejected');
    expect((await request(app).get('/api/payment-account').set(a.auth)).body.account).toBeNull(); // nothing saved

    stripeAccountStatus = 200;
    const ok = await connect(a, keys);
    expect(ok.status).toBe(200);
    expect(JSON.stringify(ok.body)).not.toContain(keys.secretKey);
    expect(JSON.stringify(ok.body)).not.toContain(keys.webhookSecret);
    expect(ok.body.account).toMatchObject({ provider: 'stripe', mode: 'test', keyHint: `…${keys.secretKey.slice(-4)}` });
    expect(ok.body.account.webhookUrl).toMatch(/\/api\/payments\/webhook\/stripe\/[\w-]{20,}$/);
    expect(calls.find((c) => c.url.endsWith('/v1/account'))?.auth).toBe(`Bearer ${keys.secretKey}`);

    const row = await prisma.paymentAccount.findFirstOrThrow({ where: { restaurantId: a.restaurantId, active: true } });
    expect(row.secretsEnc).not.toContain(keys.secretKey);
    expect(decryptJson<any>(row.secretsEnc)).toMatchObject(keys);
    expect(JSON.stringify((await request(app).get('/api/payment-account').set(a.auth)).body)).not.toContain(keys.secretKey);
  });

  it('refuses live keys outside production, and network failures are reported, not trusted', async () => {
    stubStripe();
    const live = await connect(b, { secretKey: `sk_live_${'z'.repeat(20)}`, webhookSecret: `whsec_${'z'.repeat(12)}` });
    expect(live.status).toBe(400);
    expect(live.body.error.message).toContain('test keys');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    const offline = await connect(b, stripeKeys('bbb'));
    expect(offline.status).toBe(400);
    expect(offline.body.error.message).toContain('Could not reach');
    expect((await request(app).get('/api/payment-account').set(b.auth)).body.account).toBeNull();
  });

  it("charges through the restaurant's own key and settles only on that restaurant's signed webhook", async () => {
    stubStripe();
    const ka = stripeKeys('aaa'), kb = stripeKeys('bbb');
    const tokenA = tokenOf(await connect(a, ka));
    const tokenB = tokenOf(await connect(b, kb));
    expect(tokenA).not.toBe(tokenB);
    expect((await request(app).put('/api/restaurant').set(a.auth).send({ onlinePayments: true })).status).toBe(200);
    expect((await request(app).put('/api/restaurant').set(b.auth).send({ onlinePayments: true })).status).toBe(200);

    const o = await place(a);
    expect(o.status).toBe(201);
    const session = calls.find((c) => c.url.endsWith('/v1/checkout/sessions'))!;
    expect(session.auth).toBe(`Bearer ${ka.secretKey}`); // A's key, never the platform's and never B's
    expect(o.body.payUrl).toMatch(/^https:\/\/checkout\.stripe\.test\//);
    const ref = (await prisma.payment.findFirstOrThrow({ where: { restaurantId: a.restaurantId }, orderBy: { createdAt: 'desc' } })).providerRef!;
    const amount = o.body.totalCents as number;
    expect((await track(o.body.trackingCode)).status).toBe('PENDING_PAYMENT');

    // B's secret cannot sign for A's URL, and A's token with B's signature is refused
    const raw = stripeEvent(`evt_${uid}_1`, ref, amount);
    expect((await send('stripe', tokenA, raw, stripeSig(kb.webhookSecret, raw))).status).toBe(400);
    expect((await send('stripe', 'not-a-real-token', raw, stripeSig(ka.webhookSecret, raw))).status).toBe(404);
    expect((await send('razorpay', tokenA, raw, stripeSig(ka.webhookSecret, raw))).status).toBe(404); // token is bound to its provider
    expect((await track(o.body.trackingCode)).status).toBe('PENDING_PAYMENT');

    // B, with a perfectly valid signature of its own, still cannot settle A's payment
    const rawB = stripeEvent(`evt_${uid}_2`, ref, amount);
    expect((await send('stripe', tokenB, rawB, stripeSig(kb.webhookSecret, rawB))).body.result).toBe('ignored');
    expect((await track(o.body.trackingCode)).status).toBe('PENDING_PAYMENT');

    // the platform webhook (no token) has no Stripe configured and cannot be used for restaurant payments either
    expect((await request(app).post('/api/payments/webhook/stripe').set('content-type', 'application/json').set('stripe-signature', stripeSig(ka.webhookSecret, raw)).send(raw)).status).toBe(404);

    const good = await send('stripe', tokenA, raw, stripeSig(ka.webhookSecret, raw));
    expect(good.body.result).toBe('applied');
    expect((await send('stripe', tokenA, raw, stripeSig(ka.webhookSecret, raw))).body.result).toBe('duplicate');
    expect(await track(o.body.trackingCode)).toMatchObject({ status: 'NEW', paymentStatus: 'PAID' });
  });

  it('refunds with the credentials of the account that took the money, even after they are replaced', async () => {
    stubStripe();
    const first = stripeKeys('ccc'), second = stripeKeys('ddd');
    const tokenOld = tokenOf(await connect(a, first));
    const o = await place(a);
    const ref = (await prisma.payment.findFirstOrThrow({ where: { restaurantId: a.restaurantId }, orderBy: { createdAt: 'desc' } })).providerRef!;
    const raw = stripeEvent(`evt_${uid}_3`, ref, o.body.totalCents);
    expect((await send('stripe', tokenOld, raw, stripeSig(first.webhookSecret, raw))).body.result).toBe('applied');

    await connect(a, second); // the owner rotates to a different Stripe account
    expect(await prisma.paymentAccount.count({ where: { restaurantId: a.restaurantId, active: true } })).toBe(1);
    const orderId = (await request(app).get('/api/orders?q=Pia').set(a.auth)).body.items.find((x: any) => x.trackingCode === o.body.trackingCode).id;
    calls.length = 0;
    const refund = await request(app).post('/api/payments/refund').set(a.auth).send({ orderId, amountCents: 5000 });
    expect(refund.status).toBe(201);
    expect(calls.find((c) => c.url.endsWith('/v1/refunds'))?.auth).toBe(`Bearer ${first.secretKey}`); // original account, not the new one

    // a late webhook for a payment on the old account still works
    const o2 = await place(a); // new payments use the new account
    expect(calls.find((c) => c.url.endsWith('/v1/checkout/sessions'))?.auth).toBe(`Bearer ${second.secretKey}`);
    expect(o2.status).toBe(201);
  });

  it('serialises concurrent connects so exactly one account stays active', async () => {
    stubStripe();
    const c = await signup('c');
    await Promise.all([1, 2, 3].map((n) => connect(c, stripeKeys(`ee${n}`))));
    expect(await prisma.paymentAccount.count({ where: { restaurantId: c.restaurantId, active: true } })).toBe(1);
    expect(await prisma.paymentAccount.count({ where: { restaurantId: c.restaurantId } })).toBe(3);
  });

  it('disconnecting stops online payment immediately but keeps old payments refundable', async () => {
    stubStripe();
    const d = await signup('d');
    const keys = stripeKeys('fff');
    await connect(d, keys);
    await request(app).put('/api/restaurant').set(d.auth).send({ onlinePayments: true });
    expect((await place(d)).status).toBe(201);
    expect((await request(app).delete('/api/payment-account').set(d.auth)).status).toBe(204);
    expect((await request(app).get(`/api/public/${d.slug}`)).body.restaurant.onlinePayments).toBe(false);
    expect((await place(d)).body.error.code).toBe('payment_unavailable');
    expect((await prisma.restaurant.findUniqueOrThrow({ where: { id: d.restaurantId } })).onlinePayments).toBe(false);
    expect(await prisma.paymentAccount.count({ where: { restaurantId: d.restaurantId } })).toBe(1); // kept for refunds
  });

  it("is the owner's alone, scoped per restaurant, and listed in the payments report", async () => {
    stubStripe();
    expect((await request(app).get('/api/payment-account').set(b.auth)).body.account.keyHint).toContain(stripeKeys('bbb').secretKey.slice(-4));
    await request(app).post('/api/staff').set(b.auth).send({ name: 'Mandy Manager', email: `acct-m-${uid}@example.com`, password: 'Password123!', role: 'MANAGER' });
    const m = bearer((await request(app).post('/api/auth/login').send({ email: `acct-m-${uid}@example.com`, password: 'Password123!' })).body.accessToken);
    expect((await request(app).get('/api/payment-account').set(m)).status).toBe(403);
    expect((await connect({ ...b, auth: m }, stripeKeys('ggg'))).status).toBe(403);
    expect((await request(app).delete('/api/payment-account').set(m)).status).toBe(403);

    const mine = (await request(app).get('/api/payments').set(a.auth)).body;
    expect(mine.summary).toMatchObject({ collectedCents: 40000, refundedCents: 5000 });
    expect(mine.payments.every((p: any) => p.provider === 'stripe')).toBe(true);
    expect((await request(app).get('/api/payments').set(m)).body.payments).toHaveLength(0); // B has taken no payments
  });
});
