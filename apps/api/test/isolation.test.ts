import { describe, expect, it, beforeAll } from 'vitest';
import request from 'supertest';

process.env.ENABLE_TEST_MESSAGING = '1';

import { createApp } from '../src/app';
import { prisma } from '../src/lib/core';
import { redactPath } from '../src/app';
import { productionConfigProblems } from '../src/lib/core';

const app = createApp();
const uid = Date.now().toString(36);
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

async function signup(tag: string) {
  const r = await request(app).post('/api/auth/register').send({ restaurantName: `Iso ${tag} ${uid}`, name: 'Owner', email: `iso-${tag}-${uid}@example.com`, password: 'Str0ng-Passw0rd!' });
  return { auth: bearer(r.body.accessToken), slug: r.body.restaurant.slug as string, restaurantId: r.body.restaurant.id as string };
}

describe('cross-tenant sweep: every endpoint that takes an id, attacked from another business', () => {
  let A: Awaited<ReturnType<typeof signup>>, B: Awaited<ReturnType<typeof signup>>;
  const id: Record<string, string> = {};
  const aGet = async (path: string) => (await request(app).get(`/api${path}`).set(A.auth)).body;
  const aCount = async (path: string) => (await aGet(path)).length;

  beforeAll(async () => {
    A = await signup('a'); B = await signup('b');
    const post = async (path: string, body: object) => (await request(app).post(`/api${path}`).set(A.auth).send(body)).body;
    id.cat = (await post('/categories', { name: 'A-Mains' })).id;
    id.product = (await post('/products', { categoryId: id.cat, name: 'A-Curry', priceCents: 20000 })).id;
    id.table = (await post('/tables', { label: 'A1', capacity: 4 })).id;
    id.coupon = (await post('/coupons', { code: `ASAVE${uid}`.toUpperCase().slice(0, 12), type: 'PERCENT', value: 10 })).id;
    id.supplier = (await post('/suppliers', { name: 'A-Supplier' })).id;
    id.ingredient = (await post('/ingredients', { name: 'A-Flour', unit: 'kg', lowThreshold: 1 })).id;
    await post(`/ingredients/${id.ingredient}/stock`, { type: 'PURCHASE', qty: 10 });
    id.zone = (await post('/delivery/zones', { name: 'A-Zone', feeCents: 1000 })).id;
    id.partner = (await post('/delivery/partners', { name: 'A-Rider', phone: '+919111111111' })).id;
    id.campaign = (await post('/campaigns', { name: 'A-Campaign', channel: 'EMAIL', segment: 'ALL', subject: 'Hi', body: 'Hello there' })).id;
    id.staff = (await post('/staff', { name: 'A-Waiter', email: `iso-w-${uid}@example.com`, password: 'Str0ng-Passw0rd!', role: 'WAITER' })).id;
    await request(app).put('/api/restaurant').set(A.auth).send({ published: true, orderTypes: ['TAKEAWAY'], taxPercent: 0, openTime: '00:00', closeTime: '23:59' });
    const order = await request(app).post(`/api/public/${A.slug}/orders`).send({ type: 'TAKEAWAY', customerName: 'Victim Vic', customerPhone: '+919222222222', marketingConsent: true, email: `vic-${uid}@example.com`, items: [{ productId: id.product, quantity: 1 }] });
    id.trackingCode = order.body.trackingCode;
    const o = (await aGet('/orders')).items[0];
    id.order = o.id; id.item = o.items[0].id;
    id.customer = (await aGet('/customers'))[0].id;
    const start = new Date(Date.now() + 3 * 86_400_000); start.setUTCHours(12, 0, 0, 0);
    id.reservation = (await request(app).post(`/api/public/${A.slug}/reservations`).send({ name: 'Rita Resv', phone: '+919333333333', partySize: 2, startsAt: start.toISOString() })).body.id;
  });

  it('refuses or returns nothing for every one of them, and changes nothing', async () => {
    const b = (m: 'get' | 'post' | 'put' | 'patch' | 'delete', path: string, body?: object) => (request(app) as any)[m](`/api${path}`).set(B.auth).send(body);
    const bCat = (await request(app).post('/api/categories').set(B.auth).send({ name: 'B-Cat' })).body.id;
    const productBody = { categoryId: bCat, name: 'PWNED', priceCents: 1 };

    const mutating: [string, string, object?][] = [
      ['patch', `/categories/${id.cat}`, { name: 'PWNED' }], ['delete', `/categories/${id.cat}`], ['put', '/categories/order', { ids: [id.cat] }],
      ['put', `/products/${id.product}`, productBody], ['delete', `/products/${id.product}`], ['post', `/products/${id.product}/duplicate`, {}],
      ['patch', `/products/${id.product}/availability`, { available: false }], ['put', `/products/${id.product}/recipe`, { items: [] }],
      ['delete', `/tables/${id.table}`],
      ['patch', `/coupons/${id.coupon}`, { active: false }], ['delete', `/coupons/${id.coupon}`],
      ['delete', `/suppliers/${id.supplier}`],
      ['put', `/ingredients/${id.ingredient}`, { name: 'PWNED', unit: 'kg' }], ['delete', `/ingredients/${id.ingredient}`], ['post', `/ingredients/${id.ingredient}/stock`, { type: 'WASTAGE', qty: 9 }],
      ['patch', `/orders/${id.order}/status`, { status: 'CANCELLED' }], ['patch', `/orders/${id.order}/payment`, { paymentStatus: 'PAID' }],
      ['patch', `/orders/${id.order}/delivery`, { partnerId: null }], ['patch', `/orders/${id.order}/items/${id.item}`, { done: true }],
      ['patch', `/reservations/${id.reservation}`, { status: 'CANCELLED' }],
      ['patch', `/customers/${id.customer}`, { optOut: true }], ['post', `/customers/${id.customer}/redeem`, { points: 50 }], ['post', `/customers/${id.customer}/adjust`, { points: 500, note: 'free points' }],
      ['delete', `/campaigns/${id.campaign}`], ['post', `/campaigns/${id.campaign}/send`, {}],
      ['patch', `/delivery/zones/${id.zone}`, { feeCents: 0 }], ['delete', `/delivery/zones/${id.zone}`],
      ['patch', `/delivery/partners/${id.partner}`, { active: false }], ['delete', `/delivery/partners/${id.partner}`],
      ['patch', `/staff/${id.staff}`, { active: false }],
      ['post', '/payments/refund', { orderId: id.order }], ['post', '/auth/switch-outlet', { restaurantId: A.restaurantId }],
    ];
    for (const [m, p, body] of mutating) {
      const r = await b(m as any, p, body);
      expect(`${m} ${p} -> ${r.status >= 200 && r.status < 300 && r.status !== 204 ? 'LEAK ' + JSON.stringify(r.body).slice(0, 80) : 'ok'}`, `${m} ${p}`).toMatch(/-> ok$/);
    }

    // read-by-id endpoints must not reveal anything
    for (const p of [`/customers/${id.customer}`, `/campaigns/${id.campaign}`, `/qr?tableId=${id.table}`]) expect((await b('get', p)).status, p).toBe(404);
    expect((await b('get', `/ingredients/${id.ingredient}/movements`)).body).toEqual([]);
    expect((await b('get', `/products/${id.product}/recipe`)).body).toEqual([]);

    // list endpoints show only B's own data
    for (const p of ['/products', '/categories', '/tables', '/coupons', '/suppliers', '/ingredients', '/delivery/zones', '/delivery/partners', '/campaigns', '/customers', '/reservations']) {
      const body = (await b('get', p)).body;
      expect(JSON.stringify(body), p).not.toMatch(/A-|ASAVE|Victim|Rita/);
    }
    expect((await b('get', '/orders')).body.items.length).toBe(0);
    expect((await b('get', '/staff')).body.map((u: any) => u.name)).not.toContain('A-Waiter');

    // ...and A's data is exactly as it was
    expect((await aGet('/categories'))[0].name).toBe('A-Mains');
    expect((await aGet('/products'))[0]).toMatchObject({ name: 'A-Curry', available: true });
    expect(await aCount('/products')).toBe(1);
    expect(await aCount('/tables')).toBe(1);
    expect((await aGet('/coupons'))[0].active).toBe(true);
    expect(await aCount('/suppliers')).toBe(1);
    expect((await aGet('/ingredients'))[0]).toMatchObject({ name: 'A-Flour', stockQty: 10 });
    expect((await aGet('/orders')).items[0]).toMatchObject({ status: 'NEW', paymentStatus: 'UNPAID' });
    expect((await aGet('/customers'))[0]).toMatchObject({ loyaltyPoints: 0, marketingConsent: true });
    expect((await aGet('/reservations'))[0].status).toBe('CONFIRMED');
    expect((await aGet('/campaigns'))[0].status).toBe('DRAFT');
    expect(await aCount('/delivery/zones')).toBe(1);
    expect(await aCount('/delivery/partners')).toBe(1);
    expect((await aGet('/staff')).find((u: any) => u.name === 'A-Waiter').active).toBe(true);
    expect(await prisma.category.count({ where: { restaurantId: A.restaurantId } })).toBe(1);
  });

  it('keeps the public tracking link a bearer secret that exposes no contact details', async () => {
    const t = (await request(app).get(`/api/public/orders/track/${id.trackingCode}`)).body;
    expect(JSON.stringify(t)).not.toMatch(/9222222222|vic-|Victim/);
    expect((await request(app).get('/api/public/orders/track/AAAAAAAAAAAA')).status).toBe(404);
  });
});

describe('operational safeguards', () => {
  it('keeps tokens out of logs', () => {
    expect(redactPath('/api/public/orders/track/Ab3dEfGhIjKl?x=1')).toBe('/api/public/orders/track/:code');
    expect(redactPath('/api/public/unsubscribe/0123456789abcdef0123456789abcdef')).toBe('/api/public/unsubscribe/:token');
    expect(redactPath('/api/payments/webhook/stripe/SecretTokenValue123')).toBe('/api/payments/webhook/stripe/:token');
    expect(redactPath('/api/payments/webhook/razorpay')).toBe('/api/payments/webhook/razorpay'); // platform webhook has no token
    expect(redactPath('/api/orders?q=phone')).toBe('/api/orders');
  });

  it('refuses to start in production with development settings, and accepts a proper setup', () => {
    const dev = { JWT_SECRET: 'dev-only-change-me-please-32-chars-min', DATABASE_URL: 'postgresql://tablely:tablely@localhost:5433/tablely', WEB_ORIGIN: 'http://localhost:5173', ENABLE_TEST_PAYMENTS: '1' } as NodeJS.ProcessEnv;
    expect(productionConfigProblems(dev).length).toBeGreaterThanOrEqual(5);
    const good = { JWT_SECRET: 'x7Hq2mP9vLw4Tn8Rk3Bd6Zs1Yc5Fj0Ga2Ue9Oi4Xh7Vt3Nb8Mw6Kp1Dr5Sl0Qe', SECRETS_KEY: 'k'.repeat(40), WEB_ORIGIN: 'https://app.example.com', PUBLIC_API_URL: 'https://api.example.com', RESEND_API_KEY: 're_xxxxxxxxxxxx', EMAIL_FROM: 'App <no-reply@example.com>', DATABASE_URL: 'postgresql://app:Xk29sLqpZ@db.internal:5432/app' } as NodeJS.ProcessEnv;
    expect(productionConfigProblems(good)).toEqual([]);
  });

  it('accepts a menu CSV up to its own limit but nothing else that large', async () => {
    const b = await signup('big');
    const row = 'Mains,Dish,desc,1.00,true\n';
    const ok = await request(app).post('/api/menu/import').set(b.auth).send({ csv: `category,name,description,price,available\n${row.repeat(50)}` });
    expect(ok.status).toBe(200);
    const huge = await request(app).post('/api/menu/import').set(b.auth).send({ csv: row.repeat(40_000) }); // ~1 MB
    expect(huge.status).toBe(413);
    expect((await request(app).put('/api/restaurant').set(b.auth).send({ description: 'x'.repeat(150_000) })).status).toBe(413);
  });
});
