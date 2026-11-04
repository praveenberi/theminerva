import { describe, expect, it, beforeAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';

const app = createApp();
const uid = Date.now().toString(36);
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

/** Strings that have broken real systems: SQL, markup, template injection, control characters, huge Unicode, prototype keys. */
const HOSTILE = [
  `' OR '1'='1' --`, `"; DROP TABLE "User"; --`, '<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '${7*7}{{7*7}}', '../../etc/passwd',
  'a\u0000b', '\u0000', '‮​﻿', '😀'.repeat(50), '\\', '%', '_%', 'null', 'undefined', '[object Object]', '\r\nSet-Cookie: x=1',
];

describe('hostile input never causes a server error or a leak', () => {
  let token: string, slug: string, productId: string, catId: string;
  beforeAll(async () => {
    const r = await request(app).post('/api/auth/register').send({ restaurantName: `Fuzz ${uid}`, name: 'Owner', email: `fuzz-${uid}@example.com`, password: 'Str0ng-Passw0rd!' });
    token = r.body.accessToken; slug = r.body.restaurant.slug;
    catId = (await request(app).post('/api/categories').set(bearer(token)).send({ name: 'Mains' })).body.id;
    productId = (await request(app).post('/api/products').set(bearer(token)).send({ categoryId: catId, name: 'Curry', priceCents: 1000 })).body.id;
    await request(app).put('/api/restaurant').set(bearer(token)).send({ published: true, orderTypes: ['TAKEAWAY'], taxPercent: 0 });
  });

  const noServerError = (label: string, status: number, body?: unknown) => expect(status, `${label} -> ${JSON.stringify(body)?.slice(0, 120)}`).toBeLessThan(500);

  it('survives every hostile string in search and filter parameters', async () => {
    for (const s of HOSTILE) {
      for (const path of ['/orders', '/customers', '/campaigns', '/payments', '/products']) {
        const r = await request(app).get(`/api${path}`).query({ q: s, status: s, type: s, page: s, pageSize: s, from: s, range: s }).set(bearer(token));
        noServerError(`GET ${path} q=${JSON.stringify(s)}`, r.status, r.body);
      }
    }
  });

  it('survives every hostile string in the public order form', async () => {
    for (const s of HOSTILE) {
      const r = await request(app).post(`/api/public/${slug}/orders`).send({
        type: 'TAKEAWAY', customerName: `Fz ${s}`, customerPhone: '+919000000001', notes: s, couponCode: s.slice(0, 20), referralCode: s.slice(0, 12), email: s,
        items: [{ productId, quantity: 1, notes: s }],
      });
      noServerError(`order ${JSON.stringify(s)}`, r.status, r.body);
    }
  });

  it('survives hostile strings in management forms', async () => {
    for (const s of HOSTILE) {
      for (const [path, body] of [
        ['/categories', { name: s }], ['/products', { categoryId: catId, name: s, description: s, priceCents: 1 }], ['/tables', { label: s.slice(0, 20), capacity: 2 }],
        ['/suppliers', { name: s }], ['/ingredients', { name: s, unit: s.slice(0, 12) }], ['/delivery/zones', { name: s, feeCents: 1 }],
        ['/campaigns', { name: s.length < 2 ? 'xx' : s, channel: 'EMAIL', segment: 'ALL', subject: s, body: `Hello ${s}` }], ['/menu/import', { csv: `category,name,description,price,available\n${s},${s},${s},1,true` }],
      ] as [string, object][]) {
        const r = await request(app).post(`/api${path}`).set(bearer(token)).send(body);
        noServerError(`POST ${path} ${JSON.stringify(s)}`, r.status, r.body);
      }
    }
  });

  it('handles malformed JSON, wrong types, prototype keys and missing bodies without a 500', async () => {
    const bad = [
      '{"restaurantName":', '[]', '"string"', '{"__proto__":{"admin":true},"email":"a@b.co"}', '{"constructor":{"prototype":{"x":1}}}',
      JSON.stringify({ email: ['a@b.co'], password: { $ne: null } }), JSON.stringify({ email: 'a@b.co', password: 12345678901 }), '',
    ];
    for (const raw of bad) {
      for (const path of ['/auth/login', '/auth/register', `/public/${slug}/orders`, `/public/${slug}/coupon`]) {
        const r = await request(app).post(`/api${path}`).set('content-type', 'application/json').send(raw);
        noServerError(`POST ${path} ${raw.slice(0, 40)}`, r.status, r.body);
      }
    }
    // sanity: nothing above created an admin or polluted Object.prototype
    expect(({} as any).admin).toBeUndefined();
    expect(({} as any).x).toBeUndefined();
  });

  it('answers wrong content types and methods cleanly', async () => {
    noServerError('form post', (await request(app).post('/api/auth/login').type('form').send('email=a@b.co&password=x')).status);
    noServerError('text post', (await request(app).post('/api/auth/login').set('content-type', 'text/plain').send('hello')).status);
    noServerError('bad method', (await request(app).delete('/api/auth/login')).status);
    expect((await request(app).get('/api/does-not-exist').set(bearer(token))).status).toBe(404);
    expect((await request(app).get('/api/public/%00')).status).toBeLessThan(500);
    expect((await request(app).get('/api/public/orders/track/%2e%2e%2f')).status).toBeLessThan(500);
  });
});
