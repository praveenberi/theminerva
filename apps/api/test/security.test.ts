import { describe, expect, it, beforeAll } from 'vitest';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import request from 'supertest';

process.env.ENABLE_TEST_MESSAGING = '1';

import { createApp } from '../src/app';
import { prisma } from '../src/lib/core';

const app = createApp();
const uid = Date.now().toString(36);
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const WEB = process.env.WEB_ORIGIN ?? 'http://localhost:5173';

async function signup(tag: string) {
  const agent = request.agent(app);
  const email = `sec-${tag}-${uid}@example.com`;
  const r = await agent.post('/api/auth/register').send({ restaurantName: `Sec ${tag} ${uid}`, name: 'Owner', email, password: 'Str0ng-Passw0rd!' });
  expect(r.status).toBe(201);
  const restaurant = await prisma.restaurant.findUniqueOrThrow({ where: { id: r.body.restaurant.id } });
  return { agent, email, token: r.body.accessToken as string, auth: bearer(r.body.accessToken), tenantId: restaurant.tenantId, restaurantId: restaurant.id, slug: restaurant.slug };
}
type Biz = Awaited<ReturnType<typeof signup>>;
const staffLogin = async (b: Biz, role: string, tag: string, extra: object = {}) => {
  const email = `sec-${tag}-${uid}@example.com`;
  const c = await request(app).post('/api/staff').set(b.auth).send({ name: `${role} person`, email, password: 'Str0ng-Passw0rd!', role, ...extra });
  expect(c.status).toBe(201);
  const l = await request(app).post('/api/auth/login').send({ email, password: 'Str0ng-Passw0rd!' });
  return { id: c.body.id as string, email, token: l.body.accessToken as string, auth: bearer(l.body.accessToken) };
};

describe('sessions and accounts', () => {
  let adminAuth: { Authorization: string };
  beforeAll(async () => {
    await prisma.user.create({ data: { email: `sec-admin-${uid}@example.com`, name: 'Admin', role: 'SUPER_ADMIN', passwordHash: await bcrypt.hash('Str0ng-Passw0rd!', 10) } });
    adminAuth = bearer((await request(app).post('/api/auth/login').send({ email: `sec-admin-${uid}@example.com`, password: 'Str0ng-Passw0rd!' })).body.accessToken);
  });

  it('cuts off a suspended business immediately: existing tokens, refresh and login', async () => {
    const b = await signup('susp');
    expect((await request(app).get('/api/orders').set(b.auth)).status).toBe(200);
    expect((await request(app).patch(`/api/admin/tenants/${b.tenantId}`).set(adminAuth).send({ status: 'SUSPENDED' })).status).toBe(200);
    expect((await request(app).get('/api/orders').set(b.auth)).status).toBe(403); // the 15-minute token must not outlive the suspension
    expect((await b.agent.post('/api/auth/refresh')).status).toBe(403); // and it cannot be renewed
    expect((await request(app).post('/api/auth/login').send({ email: b.email, password: 'Str0ng-Passw0rd!' })).status).toBe(403);
    await request(app).patch(`/api/admin/tenants/${b.tenantId}`).set(adminAuth).send({ status: 'ACTIVE' });
    expect((await request(app).post('/api/auth/login').send({ email: b.email, password: 'Str0ng-Passw0rd!' })).status).toBe(200);
  });

  it('revokes a deactivated or moved staff member at once, not when their token expires', async () => {
    const b = await signup('stale');
    const w = await staffLogin(b, 'WAITER', 'stale-w');
    expect((await request(app).get('/api/orders').set(w.auth)).status).toBe(200);
    await request(app).patch(`/api/staff/${w.id}`).set(b.auth).send({ active: false });
    expect((await request(app).get('/api/orders').set(w.auth)).status).toBe(401);

    // moved to another outlet: the old token (pinned to the old outlet) must stop working
    await prisma.tenant.update({ where: { id: b.tenantId }, data: { maxOutlets: 3 } });
    const second = await request(app).post('/api/outlets').set(b.auth).send({ name: `Sec second ${uid}` });
    expect(second.status).toBe(201);
    const k = await staffLogin(b, 'KITCHEN', 'stale-k');
    expect((await request(app).get('/api/kds').set(k.auth)).status).toBe(200);
    await request(app).patch(`/api/staff/${k.id}`).set(b.auth).send({ restaurantId: second.body.id });
    expect((await request(app).get('/api/kds').set(k.auth)).status).toBe(401);
  });

  it('treats a replayed refresh token as theft and ends every session of that user', async () => {
    const b = await signup('reuse');
    const t1 = b.agent.jar.getCookie('rt', { path: '/api/auth', domain: '127.0.0.1', secure: false, script: false } as any)?.value
      ?? (await b.agent.post('/api/auth/login').send({ email: b.email, password: 'Str0ng-Passw0rd!' })).headers['set-cookie'][0].split(';')[0].split('=')[1];
    const first = await request(app).post('/api/auth/refresh').set('Cookie', `rt=${t1}`);
    expect(first.status).toBe(200);
    const t2 = first.headers['set-cookie'][0].split(';')[0].split('=')[1];
    expect((await request(app).post('/api/auth/refresh').set('Cookie', `rt=${t1}`)).status).toBe(401); // replay of the used token
    expect((await request(app).post('/api/auth/refresh').set('Cookie', `rt=${t2}`)).status).toBe(401); // the attacker's/legit successor is dead too
  });

  it('locks an account after repeated wrong passwords, even for the right password, and unlocks later', async () => {
    const b = await signup('lock');
    for (let i = 0; i < 8; i++) expect((await request(app).post('/api/auth/login').send({ email: b.email, password: `wrong-guess-${i}-xyz` })).status).toBe(401);
    const locked = await request(app).post('/api/auth/login').send({ email: b.email, password: 'Str0ng-Passw0rd!' });
    expect(locked.status).toBe(401); // same generic answer: no signal that the account exists or is locked
    expect(locked.body.error.code).toBe('bad_credentials');
    await prisma.user.update({ where: { email: b.email }, data: { lockedUntil: new Date(Date.now() - 1000) } });
    expect((await request(app).post('/api/auth/login').send({ email: b.email, password: 'Str0ng-Passw0rd!' })).status).toBe(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { email: b.email } })).failedLogins).toBe(0); // success resets the counter
  });

  it('enforces a sane password policy (bcrypt only reads 72 bytes)', async () => {
    const reg = (password: string) => request(app).post('/api/auth/register').send({ restaurantName: `Pw ${uid}`, name: 'Owner', email: `sec-pw-${Math.random().toString(36).slice(2)}@example.com`, password });
    expect((await reg('short-pw1')).status).toBe(400); // 9 characters
    expect((await reg('a'.repeat(73))).status).toBe(400); // would be silently truncated
    expect((await reg('password1234')).status).toBe(400); // on the common-password list
    expect((await reg('Sunny-days-ahead-77')).status).toBe(201);
  });

  it('lets a user change their password, which ends all their other sessions', async () => {
    const b = await signup('chpw');
    const other = request.agent(app);
    const l2 = await other.post('/api/auth/login').send({ email: b.email, password: 'Str0ng-Passw0rd!' });
    expect(l2.status).toBe(200);
    expect((await request(app).post('/api/auth/change-password').set(b.auth).send({ current: 'wrong-current-pw', next: 'Another-Str0ng-One!' })).status).toBe(401);
    expect((await request(app).post('/api/auth/change-password').set(b.auth).send({ current: 'Str0ng-Passw0rd!', next: 'Another-Str0ng-One!' })).status).toBe(200);
    expect((await other.post('/api/auth/refresh')).status).toBe(401); // the other device is signed out
    expect((await request(app).post('/api/auth/login').send({ email: b.email, password: 'Str0ng-Passw0rd!' })).status).toBe(401);
    expect((await request(app).post('/api/auth/login').send({ email: b.email, password: 'Another-Str0ng-One!' })).status).toBe(200);
  });

  it('rejects forged, unsigned and mis-addressed tokens', async () => {
    const b = await signup('jwt');
    const claims = { id: 'x', role: 'SUPER_ADMIN', tenantId: null, restaurantId: null };
    const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.`;
    expect((await request(app).get('/api/admin/stats').set(bearer(none))).status).toBe(401);
    expect((await request(app).get('/api/admin/stats').set(bearer(jwt.sign(claims, 'not-the-server-secret-at-all-1234567890')))).status).toBe(401);
    // a token signed with the right secret but without our issuer/audience is not one we issued
    expect((await request(app).get('/api/orders').set(bearer(jwt.sign({ id: b.auth ? 'x' : 'x', role: 'OWNER', tenantId: b.tenantId, restaurantId: b.restaurantId }, process.env.JWT_SECRET!)))).status).toBe(401);
    expect((await request(app).get('/api/orders').set(bearer('garbage'))).status).toBe(401);
  });

  it('refuses cookie-based requests that come from another site', async () => {
    const b = await signup('csrf');
    const cookie = (await b.agent.post('/api/auth/login').send({ email: b.email, password: 'Str0ng-Passw0rd!' })).headers['set-cookie'][0].split(';')[0];
    expect((await request(app).post('/api/auth/refresh').set('Cookie', cookie).set('Origin', 'https://evil.example')).status).toBe(403);
    expect((await request(app).post('/api/auth/logout').set('Cookie', cookie).set('Origin', 'https://evil.example')).status).toBe(403);
    expect((await request(app).post('/api/auth/refresh').set('Cookie', cookie).set('Origin', WEB)).status).toBe(200);
  });
});

describe('injection and output safety', () => {
  let b: Biz, productId: string;
  beforeAll(async () => {
    b = await signup('inj');
    const cat = await request(app).post('/api/categories').set(b.auth).send({ name: 'Mains' });
    productId = (await request(app).post('/api/products').set(b.auth).send({ categoryId: cat.body.id, name: '=HYPERLINK("http://evil.example/x","click")', description: '+cmd|calc', priceCents: 100 })).body.id;
    await request(app).put('/api/restaurant').set(b.auth).send({ published: true, orderTypes: ['TAKEAWAY'], taxPercent: 0 });
  });

  it('neutralises spreadsheet formulas in the CSV export', async () => {
    const csv = (await request(app).get('/api/menu/export.csv').set(b.auth)).text;
    const lines = csv.split('\n').slice(1);
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) for (const cell of l.match(/"(?:[^"]|"")*"|[^,]+/g) ?? []) expect(/^"?[=+\-@\t\r]/.test(cell)).toBe(false);
    expect(csv).toContain("'=HYPERLINK");
  });

  it('only accepts http(s) image URLs', async () => {
    const cat = (await request(app).get('/api/categories').set(b.auth)).body[0].id;
    for (const imageUrl of ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'file:///etc/passwd'])
      expect((await request(app).post('/api/products').set(b.auth).send({ categoryId: cat, name: 'x', priceCents: 1, imageUrl })).status).toBe(400);
    expect((await request(app).post('/api/products').set(b.auth).send({ categoryId: cat, name: 'ok', priceCents: 1, imageUrl: 'https://cdn.example.com/a.jpg' })).status).toBe(201);
  });

  it('does not unsubscribe anyone from a plain GET (mail scanners prefetch links), only from a deliberate POST', async () => {
    const c = await request(app).post(`/api/public/${b.slug}/orders`).send({ type: 'TAKEAWAY', customerName: 'Una Subscribed', customerPhone: '+919700000001', marketingConsent: true, email: `una-${uid}@example.com`, items: [{ productId, quantity: 1 }] });
    expect(c.status).toBe(201);
    const row = await prisma.customer.findFirstOrThrow({ where: { restaurantId: b.restaurantId, phone: '+919700000001' } });
    const page = await request(app).get(`/api/public/unsubscribe/${row.unsubscribeToken}`);
    expect(page.status).toBe(200);
    expect(page.text).toContain('<form');
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: row.id } })).marketingConsent).toBe(true); // still subscribed
    const post = await request(app).post(`/api/public/unsubscribe/${row.unsubscribeToken}`);
    expect(post.status).toBe(200);
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: row.id } })).marketingConsent).toBe(false);
    expect((await request(app).post('/api/public/unsubscribe/nope')).status).toBe(404);
  });

  it('escapes names in the unsubscribe page', async () => {
    await prisma.restaurant.update({ where: { id: b.restaurantId }, data: { name: `Cafe <img src=x onerror=alert(1)> & "Co"` } });
    const row = await prisma.customer.findFirstOrThrow({ where: { restaurantId: b.restaurantId, phone: '+919700000001' } });
    const html = (await request(app).post(`/api/public/unsubscribe/${row.unsubscribeToken}`)).text;
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });
});

describe('privacy by role', () => {
  it('hides customer phone numbers and addresses from the kitchen', async () => {
    const b = await signup('priv');
    const cat = await request(app).post('/api/categories').set(b.auth).send({ name: 'Mains' });
    const p = (await request(app).post('/api/products').set(b.auth).send({ categoryId: cat.body.id, name: 'Dosa', priceCents: 100 })).body.id;
    await request(app).put('/api/restaurant').set(b.auth).send({ published: true, orderTypes: ['DELIVERY'], taxPercent: 0 });
    expect((await request(app).post(`/api/public/${b.slug}/orders`).send({ type: 'DELIVERY', customerName: 'Pri Vacy', customerPhone: '+919800000099', address: '12 Secret Lane', items: [{ productId: p, quantity: 1 }] })).status).toBe(201);
    const k = await staffLogin(b, 'KITCHEN', 'priv-k');
    const o = (await request(app).get('/api/orders').set(k.auth)).body.items[0];
    expect(o.customerPhone).toBeUndefined();
    expect(o.address).toBeUndefined();
    expect(o.items.length).toBe(1); // what to cook is still there
    const owner = (await request(app).get('/api/orders').set(b.auth)).body.items[0];
    expect(owner.customerPhone).toBe('+919800000099');
  });
});

describe('transport and abuse limits', () => {
  it('sends hardened headers and never caches API responses', async () => {
    const b = await signup('hdr');
    const r = await request(app).get('/api/orders').set(b.auth);
    expect(r.headers['x-powered-by']).toBeUndefined();
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['cache-control']).toContain('no-store');
  });

  it('rejects oversized request bodies', async () => {
    const big = { restaurantName: 'x'.repeat(2), name: 'y', email: 'a@b.co', password: 'z'.repeat(300_000) };
    expect((await request(app).post('/api/auth/register').send(big)).status).toBe(413);
  });

  it('applies a global per-IP rate limit', async () => {
    const prev = process.env.API_RATE_LIMIT;
    process.env.API_RATE_LIMIT = '12';
    try {
      const limited = createApp();
      const codes: number[] = [];
      for (let i = 0; i < 20; i++) codes.push((await request(limited).get('/api/public/plans')).status);
      expect(codes.filter((c) => c === 429).length).toBeGreaterThanOrEqual(5);
      expect(codes.slice(0, 10).every((c) => c === 200)).toBe(true);
      expect((await request(limited).get('/api/health')).status).toBe(200); // health checks are exempt
    } finally {
      if (prev === undefined) delete process.env.API_RATE_LIMIT; else process.env.API_RATE_LIMIT = prev;
    }
  });
});
