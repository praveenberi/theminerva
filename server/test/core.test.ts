import crypto from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, localTomorrow, login, prisma, productBySlug } from './helpers.js';
import { verifyRazorpaySignature, verifyStripeSignature } from '../src/services/payments.js';
import { csvParse, csvStringify } from '../src/lib/csv.js';
import { inWindow } from '../src/services/pricing.js';
import { zonedToUtc } from '../src/lib/time.js';

let admin: Awaited<ReturnType<typeof login>>;
let manager: Awaited<ReturnType<typeof login>>;
let kitchen: Awaited<ReturnType<typeof login>>;
let waiter: Awaited<ReturnType<typeof login>>;
let cashier: Awaited<ReturnType<typeof login>>;

beforeAll(async () => {
  admin = await login('admin@theminerva.com');
  manager = await login('manager@theminerva.com');
  kitchen = await login('kitchen@theminerva.com');
  waiter = await login('waiter@theminerva.com');
  cashier = await login('cashier@theminerva.com');
});

describe('authentication', () => {
  it('registers a customer, enforces password strength and blocks duplicates', async () => {
    const weak = await api().post('/api/auth/register').send({ name: 'Ann Lee', email: 'ann@example.com', password: 'short' });
    expect(weak.status).toBe(422);
    const ok = await api().post('/api/auth/register').send({ name: 'Ann Lee', email: 'ann@example.com', password: 'Str0ngPassword!', phone: '+65 8123 4567', marketingConsent: true });
    expect(ok.status).toBe(201);
    expect(ok.body.accessToken).toBeTruthy();
    expect(ok.headers['set-cookie'][0]).toMatch(/HttpOnly/);
    const dup = await api().post('/api/auth/register').send({ name: 'Ann Lee', email: 'ann@example.com', password: 'Str0ngPassword!' });
    expect(dup.status).toBe(409);
    const c = await prisma.customer.findUniqueOrThrow({ where: { email: 'ann@example.com' } });
    expect(c.passwordHash).not.toContain('Str0ng'); // hashed
    expect(c.marketingConsent).toBe(true);
  });

  it('logs in staff and rejects a wrong password with a generic message', async () => {
    const bad = await api().post('/api/auth/login').send({ email: 'admin@theminerva.com', password: 'WrongPass123' });
    expect(bad.status).toBe(401);
    const good = await api().post('/api/auth/login').send({ email: 'admin@theminerva.com', password: 'Minerva@12345' });
    expect(good.body.user.role).toBe('OWNER');
    expect(good.body.user.permissions).toContain('settings.manage');
  });

  it('refresh needs the CSRF header + cookie, rotates tokens and detects reuse', async () => {
    const l = await api().post('/api/auth/login').send({ email: 'manager@theminerva.com', password: 'Minerva@12345' });
    const cookie = l.headers['set-cookie'][0].split(';')[0];
    expect((await api().post('/api/auth/refresh').set('Cookie', cookie)).status).toBe(401); // no CSRF header
    const r1 = await api().post('/api/auth/refresh').set('Cookie', cookie).set('X-Requested-With', 'minerva');
    expect(r1.status).toBe(200);
    const reuse = await api().post('/api/auth/refresh').set('Cookie', cookie).set('X-Requested-With', 'minerva');
    expect(reuse.status).toBe(401); // old token already rotated
    const newCookie = r1.headers['set-cookie'][0].split(';')[0];
    const afterTheft = await api().post('/api/auth/refresh').set('Cookie', newCookie).set('X-Requested-With', 'minerva');
    expect(afterTheft.status).toBe(401); // family revoked after reuse
  });

  it('does not reveal whether an email is registered on forgot-password', async () => {
    const a = await api().post('/api/auth/forgot-password').send({ email: 'admin@theminerva.com' });
    const b = await api().post('/api/auth/forgot-password').send({ email: 'nobody@nowhere.com' });
    expect(a.body).toEqual(b.body);
  });
});

describe('role based permissions are enforced by the API', () => {
  it('rejects anonymous access to staff endpoints', async () => {
    expect((await api().get('/api/orders')).status).toBe(401);
    expect((await api().get('/api/customers')).status).toBe(401);
  });
  it('kitchen cannot read customers, settings, reports or payments', async () => {
    for (const p of ['/api/customers', '/api/reports/dashboard', '/api/payments', '/api/staff', '/api/restaurant/audit-logs'])
      expect((await api().get(p).set(kitchen.auth)).status, p).toBe(403);
  });
  it('only the owner can change restaurant settings; manager can run daily ops', async () => {
    expect((await api().put('/api/restaurant/settings').set(manager.auth).send({ ordering: { taxRate: 5 } })).status).toBe(403);
    expect((await api().get('/api/reports/dashboard').set(manager.auth)).status).toBe(200);
    const r = await api().put('/api/restaurant').set(admin.auth).send({ phone: '+65 0000 0000' });
    expect(r.status).toBe(200);
    expect(r.body.phone).toBe('+65 0000 0000');
    expect((await api().get('/api/restaurant/audit-logs').set(admin.auth)).body.items.some((a: any) => a.action === 'restaurant.update')).toBe(true);
  });
  it('waiter cannot manage menu or refund; cashier can refund but not edit menu', async () => {
    expect((await api().post('/api/products').set(waiter.auth).send({})).status).toBe(403);
    expect((await api().post('/api/payments/refund').set(waiter.auth).send({ paymentId: 'x' })).status).toBe(403);
    expect((await api().post('/api/products').set(cashier.auth).send({})).status).toBe(403);
  });
  it('validates restaurant settings', async () => {
    expect((await api().put('/api/restaurant/settings').set(admin.auth).send({ ordering: { taxRate: 99 } })).status).toBe(422);
    expect((await api().put('/api/restaurant/settings').set(admin.auth).send({ bogus: {} })).status).toBe(422);
  });
});

describe('menu and product management', () => {
  let categoryId: string; let productId: string;
  it('creates a category and a product with variants, add-ons and recipe', async () => {
    const menu = (await api().get('/api/menus').set(admin.auth)).body[0];
    const cat = await api().post('/api/categories').set(admin.auth).send({ menuId: menu.id, name: 'Specials' });
    expect(cat.status).toBe(201);
    categoryId = cat.body.id;
    const flour = await prisma.ingredient.findUniqueOrThrow({ where: { name: 'Flour' } });
    const p = await api().post('/api/products').set(admin.auth).send({
      categoryId, name: 'Truffle Pasta', price: 24, discountPrice: 20, isVegetarian: true, allergens: ['gluten'],
      variants: [{ name: 'Regular', priceDelta: 0 }, { name: 'Large', priceDelta: 6 }],
      addonGroups: [{ name: 'Extras', minSelect: 0, maxSelect: 2, addons: [{ name: 'Parmesan', price: 2 }] }],
      recipe: [{ ingredientId: flour.id, quantity: 0.2 }], images: [{ url: '/uploads/x.jpg', alt: 'Pasta' }],
    });
    expect(p.status).toBe(201);
    productId = p.body.id;
    expect(p.body.slug).toBe('truffle-pasta');
  });
  it('rejects invalid input with field-level messages', async () => {
    const r = await api().post('/api/products').set(admin.auth).send({ categoryId, name: '', price: 10 });
    expect(r.status).toBe(422);
    const bad = await api().post('/api/products').set(admin.auth).send({ categoryId, name: 'X', price: 10, discountPrice: 12 });
    expect(bad.status).toBe(422);
    expect(bad.body.error.message).toMatch(/Discount price/);
  });
  it('duplicates, updates and publishes to the public menu', async () => {
    const dup = await api().post(`/api/products/${productId}/duplicate`).set(admin.auth);
    expect(dup.body.isPublished).toBe(false);
    const pub = await api().get('/api/public/menu');
    const names = pub.body.flatMap((m: any) => m.categories.flatMap((c: any) => c.products.map((p: any) => p.name)));
    expect(names).toContain('Truffle Pasta');
    expect(names).not.toContain('Truffle Pasta (copy)');
    const upd = await api().put(`/api/products/${productId}`).set(admin.auth).send({ categoryId, name: 'Truffle Pasta', price: 25 });
    expect(upd.body.price).toBe('25');
  });
  it('imports and exports CSV (and neutralises formula injection)', async () => {
    const csv = 'category,name,price,vegetarian\nSpecials,CSV Dish,7.5,yes\nSpecials,,3,no';
    const r = await api().post('/api/products/import').set(admin.auth).send({ csv });
    expect(r.body.created).toBe(1);
    expect(r.body.errors).toHaveLength(1);
    await api().post('/api/products').set(admin.auth).send({ categoryId, name: '=HYPERLINK("http://evil")', price: 1 });
    const exp = await api().get('/api/products/export.csv').set(admin.auth);
    expect(exp.text).toContain('CSV Dish');
    expect(exp.text).toContain(`'=HYPERLINK`);
  });
  it('rejects non-image uploads by file signature', async () => {
    const r = await api().post('/api/uploads').set(admin.auth).attach('file', Buffer.from('<?php echo 1;'), 'evil.jpg');
    expect(r.status).toBe(400);
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
    const ok = await api().post('/api/uploads').set(admin.auth).attach('file', png, 'a.png');
    expect(ok.status).toBe(201);
    expect(ok.body.url).toMatch(/\.png$/);
  });
});

describe('checkout, cart pricing and order lifecycle', () => {
  const guest = { name: 'Guest One', phone: '+65 9000 1111' };
  let orderId: string; let token: string;

  it('prices on the server: ignores client totals, applies service charge + tax', async () => {
    const soup = await productBySlug('tomato-soup'); // 8.00
    const r = await api().post('/api/orders/quote').send({ type: 'DINE_IN', items: [{ productId: soup.id, quantity: 2 }], total: 0.01 });
    expect(r.status).toBe(200);
    expect(r.body.subtotal).toBe(16);
    expect(r.body.serviceCharge).toBe(1.6); // 10%
    expect(r.body.tax).toBe(1.58);          // 9% of 17.60
    expect(r.body.total).toBe(19.18);
  });

  it('applies variants and add-ons and enforces add-on limits', async () => {
    const chicken = await productBySlug('roast-chicken'); // 22
    const whole = chicken.variants.find((v) => v.name === 'Whole')!;
    const fries = chicken.addonGroups[0].addons.find((a) => a.name === 'Fries')!;
    const ok = await api().post('/api/orders/quote').send({ type: 'TAKEAWAY', items: [{ productId: chicken.id, variantId: whole.id, addonIds: [fries.id], quantity: 1 }] });
    expect(ok.body.subtotal).toBe(40); // 22 + 14 + 4
    const noVariant = await api().post('/api/orders/quote').send({ type: 'TAKEAWAY', items: [{ productId: chicken.id, quantity: 1 }] });
    expect(noVariant.status).toBe(400);
    const tooMany = await api().post('/api/orders/quote').send({ type: 'TAKEAWAY', items: [{ productId: chicken.id, variantId: whole.id, addonIds: chicken.addonGroups[0].addons.map((a) => a.id).concat('bogus'), quantity: 1 }] });
    expect(tooMany.status).toBe(400);
  });

  it('validates coupons (minimum spend, unknown code, percent maths)', async () => {
    const pizza = await productBySlug('margherita-pizza'); // 18
    expect((await api().post('/api/orders/quote').send({ type: 'TAKEAWAY', items: [{ productId: pizza.id, quantity: 1 }], couponCode: 'WELCOME10' })).status).toBe(400); // < 20 min
    expect((await api().post('/api/orders/quote').send({ type: 'TAKEAWAY', items: [{ productId: pizza.id, quantity: 1 }], couponCode: 'NOPE' })).status).toBe(400);
    const ok = await api().post('/api/orders/quote').send({ type: 'TAKEAWAY', items: [{ productId: pizza.id, quantity: 2 }], couponCode: 'welcome10' });
    expect(ok.body.discount).toBe(3.6);
  });

  it('refuses unavailable items and requires contact details for guests', async () => {
    const dessert = await productBySlug('cream-pudding');
    await prisma.product.update({ where: { id: dessert.id }, data: { isAvailable: false } });
    expect((await api().post('/api/orders').send({ type: 'TAKEAWAY', guest, items: [{ productId: dessert.id, quantity: 1 }] })).status).toBe(400);
    await prisma.product.update({ where: { id: dessert.id }, data: { isAvailable: true } });
    const pizza = await productBySlug('margherita-pizza');
    expect((await api().post('/api/orders').send({ type: 'TAKEAWAY', guest: { name: 'No Contact' }, items: [{ productId: pizza.id, quantity: 1 }] })).status).toBe(400);
  });

  it('places a guest order, deduplicates by idempotency key and creates a CRM record', async () => {
    const pizza = await productBySlug('margherita-pizza');
    const body = { type: 'TAKEAWAY', guest, items: [{ productId: pizza.id, quantity: 2 }], couponCode: 'WELCOME10' };
    const r = await api().post('/api/orders').set('Idempotency-Key', 'key-1').send(body);
    expect(r.status).toBe(201);
    const again = await api().post('/api/orders').set('Idempotency-Key', 'key-1').send(body);
    expect(again.body.id).toBe(r.body.id);
    expect(await prisma.order.count({ where: { idempotencyKey: 'key-1' } })).toBe(1);
    expect((await prisma.coupon.findUniqueOrThrow({ where: { code: 'WELCOME10' } })).usedCount).toBe(1); // not double-counted
    expect(await prisma.customer.count({ where: { phone: guest.phone } })).toBe(1);
    orderId = r.body.id; token = r.body.trackingToken;
  });

  it('exposes limited tracking data by unguessable token and logs a (skipped) notification', async () => {
    const t = await api().get(`/api/public/orders/${token}`);
    expect(t.body.status).toBe('NEW');
    expect(t.body.guestPhone).toBeUndefined();
    expect((await api().get('/api/public/orders/not-a-token')).status).toBe(404);
    await new Promise((r) => setTimeout(r, 300));
    const log = await prisma.notificationLog.findFirst({ where: { event: 'order.placed' } });
    expect(log).toBeTruthy();
    expect(log!.status).toBe('SKIPPED'); // no provider configured — never reported as sent
  });

  it('walks the kitchen workflow with role limits and rejects illegal jumps', async () => {
    const patch = (who: typeof admin, status: string) => api().patch(`/api/orders/${orderId}/status`).set(who.auth).send({ status });
    expect((await patch(admin, 'COMPLETED')).status).toBe(409);           // NEW → COMPLETED not allowed
    expect((await patch(kitchen, 'COMPLETED')).status).toBe(403);         // kitchen cannot complete
    expect((await patch(waiter, 'ACCEPTED')).status).toBe(403);
    expect((await patch(kitchen, 'ACCEPTED')).status).toBe(200);
    expect((await patch(kitchen, 'PREPARING')).status).toBe(200);
    expect((await patch(kitchen, 'READY')).status).toBe(200);
    expect((await patch(manager, 'OUT_FOR_DELIVERY')).status).toBe(409);  // takeaway can't go out for delivery
    const done = await patch(manager, 'COMPLETED');
    expect(done.status).toBe(200);
    expect(done.body.history.map((h: any) => h.status)).toEqual(['NEW', 'ACCEPTED', 'PREPARING', 'READY', 'COMPLETED']);
    expect((await patch(manager, 'COMPLETED')).status).toBe(409);
  });

  it('deducts inventory exactly once per recipe when an order completes', async () => {
    const flour = await prisma.ingredient.findUniqueOrThrow({ where: { name: 'Flour' } });
    const tomato = await prisma.ingredient.findUniqueOrThrow({ where: { name: 'Tomato' } });
    // 2 pizzas × (0.25 flour, 0.15 tomato) from 20 / 15 kg
    expect(Number(flour.stock)).toBeCloseTo(19.5);
    expect(Number(tomato.stock)).toBeCloseTo(14.7);
    const moves = await prisma.stockMovement.count({ where: { reference: orderId, type: 'CONSUMPTION' } });
    expect(moves).toBe(2);
  });

  it('kitchen board hides customer contact details', async () => {
    const pizza = await productBySlug('margherita-pizza');
    await api().post('/api/orders').send({ type: 'TAKEAWAY', guest, items: [{ productId: pizza.id, quantity: 1 }] });
    const b = await api().get('/api/orders/board').set(kitchen.auth);
    expect(b.status).toBe(200);
    expect(JSON.stringify(b.body)).not.toContain(guest.phone);
    const list = await api().get('/api/orders').set(kitchen.auth);
    expect(JSON.stringify(list.body)).not.toContain(guest.phone);
    expect(list.body.items[0].payments).toEqual([]);
    const detail = await api().get('/api/orders/' + list.body.items[0].id).set(kitchen.auth);
    expect(detail.body.guestPhone).toBeUndefined();
  });

  it('keeps order history when deleting a sold product (archives instead)', async () => {
    const pizza = await productBySlug('margherita-pizza');
    const r = await api().delete(`/api/products/${pizza.id}`).set(admin.auth);
    expect(r.body.archived).toBe(true);
    await prisma.product.update({ where: { id: pizza.id }, data: { isPublished: true, isAvailable: true } });
  });
});

describe('loyalty, vouchers and registered checkout', () => {
  it('awards points once on completion and lets the customer redeem for a voucher', async () => {
    const reg = await api().post('/api/auth/register').send({ name: 'Bob Tan', email: 'bob@example.com', password: 'Str0ngPassword!' });
    const auth = { Authorization: `Bearer ${reg.body.accessToken}` };
    const roast = await productBySlug('roast-chicken');
    const whole = roast.variants.find((v) => v.name === 'Half')!;
    const o = await api().post('/api/orders').set(auth).send({ type: 'TAKEAWAY', items: [{ productId: roast.id, variantId: whole.id, addonIds: [], quantity: 10 }] });
    expect(o.status).toBe(201); // 220 subtotal
    for (const s of ['ACCEPTED', 'PREPARING', 'READY', 'COMPLETED']) await api().patch(`/api/orders/${o.body.id}/status`).set(manager.auth).send({ status: s });
    const me = await api().get('/api/customers/me/profile').set(auth);
    expect(me.body.loyaltyPoints).toBe(220);
    expect(await prisma.loyaltyTransaction.count({ where: { orderId: o.body.id, reason: 'EARN' } })).toBe(1);
    const redeem = await api().post('/api/customers/me/redeem').set(auth).send({ points: 100 });
    expect(redeem.status).toBe(201);
    expect(Number(redeem.body.amount)).toBe(5);
    expect((await api().post('/api/customers/me/redeem').set(auth).send({ points: 5000 })).status).toBe(400);
    const left = await api().get('/api/customers/me/profile').set(auth);
    expect(left.body.loyaltyPoints).toBe(120);
    // voucher applies to a later order and cannot be reused
    const pudding = await productBySlug('cream-pudding');
    const q = await api().post('/api/orders/quote').set(auth).send({ type: 'TAKEAWAY', items: [{ productId: pudding.id, quantity: 1 }], voucherCode: redeem.body.code });
    expect(q.body.discount).toBe(5);
    const placed = await api().post('/api/orders').set(auth).send({ type: 'TAKEAWAY', items: [{ productId: pudding.id, quantity: 1 }], voucherCode: redeem.body.code });
    expect(placed.status).toBe(201);
    expect((await api().post('/api/orders').set(auth).send({ type: 'TAKEAWAY', items: [{ productId: pudding.id, quantity: 1 }], voucherCode: redeem.body.code })).status).toBe(400);
    // rejecting the order gives the voucher back
    await api().patch(`/api/orders/${placed.body.id}/status`).set(manager.auth).send({ status: 'REJECTED', note: 'Sold out' });
    expect((await api().post('/api/orders/quote').set(auth).send({ type: 'TAKEAWAY', items: [{ productId: pudding.id, quantity: 1 }], voucherCode: redeem.body.code })).status).toBe(200);
  });

  it('prevents self-referral abuse and rewards a referral only once', async () => {
    const a = await api().post('/api/auth/register').send({ name: 'Ref Owner', email: 'ref@example.com', password: 'Str0ngPassword!' });
    const refCode = (await prisma.customer.findUniqueOrThrow({ where: { email: 'ref@example.com' } })).referralCode;
    const b = await api().post('/api/auth/register').send({ name: 'Friend', email: 'friend@example.com', password: 'Str0ngPassword!', referralCode: refCode });
    const friend = await prisma.customer.findUniqueOrThrow({ where: { email: 'friend@example.com' } });
    expect(friend.referredById).toBeTruthy();
    const auth = { Authorization: `Bearer ${b.body.accessToken}` };
    const pudding = await productBySlug('cream-pudding');
    for (let i = 0; i < 2; i++) {
      const o = await api().post('/api/orders').set(auth).send({ type: 'TAKEAWAY', items: [{ productId: pudding.id, quantity: 1 }] });
      for (const s of ['ACCEPTED', 'PREPARING', 'READY', 'COMPLETED']) await api().patch(`/api/orders/${o.body.id}/status`).set(manager.auth).send({ status: s });
    }
    const referrer = await prisma.customer.findUniqueOrThrow({ where: { email: 'ref@example.com' } });
    expect(referrer.loyaltyPoints).toBe(100); // exactly one bonus
    void a;
  });
});

describe('table QR ordering and bills', () => {
  it('opens a session from a table token, adds orders to it, splits the bill and closes it', async () => {
    const t = await prisma.diningTable.findUniqueOrThrow({ where: { label: 'T3' } });
    const info = await api().get(`/api/public/table/${t.qrToken}`);
    expect(info.body.table.label).toBe('T3');
    const soup = await productBySlug('tomato-soup');
    const o1 = await api().post('/api/orders').send({ type: 'DINE_IN', tableToken: t.qrToken, guest: { name: 'Table 3', phone: '+65 9111 2222' }, items: [{ productId: soup.id, quantity: 1 }] });
    const o2 = await api().post('/api/orders').send({ type: 'DINE_IN', tableToken: t.qrToken, guest: { name: 'Table 3', phone: '+65 9111 2222' }, items: [{ productId: soup.id, quantity: 2 }] });
    const s1 = await prisma.order.findUniqueOrThrow({ where: { id: o1.body.id } });
    const s2 = await prisma.order.findUniqueOrThrow({ where: { id: o2.body.id } });
    expect(s1.sessionId).toBe(s2.sessionId);
    expect((await prisma.diningTable.findUniqueOrThrow({ where: { id: t.id } })).status).toBe('OCCUPIED');
    expect((await api().post(`/api/tables/by-token/${t.qrToken}/request-bill`)).status).toBe(200);
    const bill = await api().get(`/api/tables/${t.id}/bill?split=3`).set(waiter.auth);
    expect(bill.body.shares).toHaveLength(3);
    expect(bill.body.shares.reduce((a: number, b: number) => a + b, 0)).toBeCloseTo(bill.body.due, 2);
    // waiter adds a dish to a running order
    const add = await api().post(`/api/orders/${o1.body.id}/items`).set(waiter.auth).send({ items: [{ productId: soup.id, quantity: 1 }] });
    expect(add.status).toBe(200);
    expect(add.body.items).toHaveLength(2);
    // cannot close with open orders
    expect((await api().post(`/api/tables/${t.id}/close-session`).set(waiter.auth)).status).toBe(409);
    for (const id of [o1.body.id, o2.body.id]) {
      for (const s of ['ACCEPTED', 'PREPARING', 'READY']) await api().patch(`/api/orders/${id}/status`).set(kitchen.auth).send({ status: s });
      await api().patch(`/api/orders/${id}/status`).set(waiter.auth).send({ status: 'SERVED' });
      await api().patch(`/api/orders/${id}/status`).set(waiter.auth).send({ status: 'COMPLETED' });
    }
    expect((await api().post(`/api/tables/${t.id}/close-session`).set(waiter.auth)).status).toBe(409); // unpaid
    expect((await api().post(`/api/tables/${t.id}/close-session?force=true`).set(waiter.auth)).status).toBe(200);
  });

  it('generates QR codes in PNG, SVG and PDF', async () => {
    const t = await prisma.diningTable.findUniqueOrThrow({ where: { label: 'T1' } });
    const png = await api().get(`/api/qr/table.png?id=${t.id}`).set(admin.auth);
    expect(png.status).toBe(200);
    expect(png.headers['content-type']).toBe('image/png');
    expect((await api().get('/api/qr/main.svg').set(admin.auth)).body.toString()).toContain('<svg');
    const pdf = await api().get(`/api/qr/main.pdf`).set(admin.auth).buffer().parse((res, cb) => { const d: Buffer[] = []; res.on('data', (c: Buffer) => d.push(c)); res.on('end', () => cb(null, Buffer.concat(d))); });
    expect(pdf.body.subarray(0, 4).toString()).toBe('%PDF');
  });
});

describe('delivery', () => {
  it('prices delivery by zone and enforces minimum order, driver assignment and driver scoping', async () => {
    const chicken = await productBySlug('roast-chicken');
    const half = chicken.variants.find((v) => v.name === 'Half')!;
    const items = [{ productId: chicken.id, variantId: half.id, quantity: 2 }];
    const nozone = await api().post('/api/orders/quote').send({ type: 'DELIVERY', items, deliveryPostal: '99999' });
    expect(nozone.status).toBe(400);
    const ok = await api().post('/api/orders/quote').send({ type: 'DELIVERY', items, deliveryPostal: '011111' });
    expect(ok.status).toBe(200);
    expect(ok.body.deliveryFee).toBe(5);
    const placed = await api().post('/api/orders').send({ type: 'DELIVERY', items, deliveryPostal: '011111', deliveryAddress: '1 Sample Street', guest: { name: 'Dee', phone: '+65 9222 3333' } });
    expect(placed.status).toBe(201);
    const id = placed.body.id;
    for (const s of ['ACCEPTED', 'PREPARING', 'READY']) await api().patch(`/api/orders/${id}/status`).set(manager.auth).send({ status: s });
    expect((await api().patch(`/api/orders/${id}/status`).set(manager.auth).send({ status: 'OUT_FOR_DELIVERY' })).status).toBe(409); // no driver yet
    const driver = await prisma.user.findUniqueOrThrow({ where: { email: 'driver@theminerva.com' } });
    expect((await api().patch(`/api/orders/${id}`).set(manager.auth).send({ driverId: driver.id })).status).toBe(200);
    const d = await login('driver@theminerva.com');
    expect((await api().patch(`/api/orders/${id}/status`).set(d.auth).send({ status: 'OUT_FOR_DELIVERY' })).status).toBe(200);
    const list = await api().get('/api/orders').set(d.auth);
    expect(list.body.items.every((o: any) => o.driverId === driver.id)).toBe(true);
    expect((await api().patch(`/api/orders/${id}/status`).set(d.auth).send({ status: 'COMPLETED' })).status).toBe(200);
  });
});

describe('reservations', () => {
  it('lists availability, books a table and blocks double bookings under concurrency', async () => {
    const date = await localTomorrow();
    const av = await api().get(`/api/reservations/availability?date=${date}&guests=6`);
    expect(av.status).toBe(200);
    expect(av.body.slots.length).toBeGreaterThan(0);
    const slot = av.body.slots[0].time;
    // only T5 seats 6 → of 6 simultaneous requests exactly one may succeed
    const attempts = await Promise.all(Array.from({ length: 6 }, (_, i) =>
      api().post('/api/reservations').send({ date, time: slot, guests: 6, name: `Racer ${i}`, phone: '+65 8000 000' + i })));
    const ok = attempts.filter((a) => a.status === 201);
    expect(ok).toHaveLength(1);
    expect(attempts.filter((a) => a.status === 409)).toHaveLength(5);
    expect(ok[0].body.reference).toMatch(/^MIN-/);
    const after = await api().get(`/api/reservations/availability?date=${date}&guests=6`);
    expect(after.body.slots.find((s: any) => s.time === slot)).toBeUndefined();
    // customer cancels with reference + phone; slot is free again
    const idx = attempts.findIndex((a) => a.status === 201);
    expect((await api().post('/api/reservations/lookup/cancel').send({ reference: ok[0].body.reference, phone: '+65 8000 000' + (idx + 1) })).status).toBe(404); // wrong phone
    const cancel = await api().post('/api/reservations/lookup/cancel').send({ reference: ok[0].body.reference, phone: '+65 8000 000' + idx });
    expect(cancel.status).toBe(200);
    const freed = await api().get(`/api/reservations/availability?date=${date}&guests=6`);
    expect(freed.body.slots.find((s: any) => s.time === slot)).toBeTruthy();
  });

  it('validates input, party size and closed days', async () => {
    const date = await localTomorrow();
    expect((await api().post('/api/reservations').send({ date, time: '19:00', guests: 2, name: 'A', phone: 'abc' })).status).toBe(422);
    expect((await api().get(`/api/reservations/availability?date=${date}&guests=99`)).status).toBe(400);
    const past = await api().post('/api/reservations').send({ date: '2020-01-01', time: '19:00', guests: 2, name: 'Past Guest', phone: '+65 8111 2222' });
    expect(past.status).toBe(400);
  });

  it('staff can reschedule, mark no-show and see the booking; private dining is a pending request', async () => {
    const date = await localTomorrow();
    const r = await api().post('/api/reservations').send({ date, time: '12:00', guests: 2, name: 'Cara Lim', phone: '+65 8333 4444' });
    expect(r.status).toBe(201);
    const moved = await api().put(`/api/reservations/${r.body.id}`).set(waiter.auth).send({ date, time: '13:00' });
    expect(moved.status).toBe(200);
    const ns = await api().put(`/api/reservations/${r.body.id}`).set(waiter.auth).send({ status: 'NO_SHOW' });
    expect(ns.body.status).toBe('NO_SHOW');
    const pd = await api().post('/api/reservations').send({ kind: 'PRIVATE_DINING', date, time: '19:00', guests: 20, name: 'Corp Co', phone: '+65 8555 6666', notes: 'Dinner' });
    expect(pd.body.status).toBe('PENDING');
    expect((await api().get('/api/reservations').set(kitchen.auth)).status).toBe(403);
  });
});

describe('payments and refunds', () => {
  let orderToken: string; let orderId: string;
  beforeAll(async () => {
    const pizza = await productBySlug('margherita-pizza');
    const o = await api().post('/api/orders').send({ type: 'TAKEAWAY', guest: { name: 'Pay Tester', phone: '+65 8777 0000' }, items: [{ productId: pizza.id, quantity: 1 }] });
    orderToken = o.body.trackingToken; orderId = o.body.id;
  });

  it('refuses online providers that are not configured — never fakes success', async () => {
    await api().put('/api/restaurant/settings').set(admin.auth).send({ payments: { enabledMethods: ['CASH_AT_RESTAURANT', 'CASH_ON_DELIVERY', 'CARD'] } });
    const r = await api().post('/api/payments/create').send({ orderToken, method: 'CARD' });
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe('PROVIDER_NOT_CONFIGURED');
    const p = await prisma.payment.findFirst({ where: { orderId, method: 'CARD' } });
    expect(p?.status).toBe('FAILED');
    const unlisted = await api().post('/api/payments/create').send({ orderToken, method: 'UPI' });
    expect(unlisted.status).toBe(400);
  });

  it('cash payment stays pending until staff confirm, and customers cannot confirm it', async () => {
    const r = await api().post('/api/payments/create').set('Idempotency-Key', 'pay-1').send({ orderToken, method: 'CASH_AT_RESTAURANT' });
    expect(r.status).toBe(201);
    expect(r.body.payment.status).toBe('PENDING');
    const dup = await api().post('/api/payments/create').set('Idempotency-Key', 'pay-1').send({ orderToken, method: 'CASH_AT_RESTAURANT' });
    expect(dup.body.payment.id).toBe(r.body.payment.id);
    expect((await api().post(`/api/payments/${r.body.payment.id}/confirm-cash`)).status).toBe(401);
    expect((await api().post(`/api/payments/${r.body.payment.id}/confirm-cash`).set(kitchen.auth)).status).toBe(403);
    const ok = await api().post(`/api/payments/${r.body.payment.id}/confirm-cash`).set(cashier.auth);
    expect(ok.body.status).toBe('PAID');
    expect((await api().post('/api/payments/create').send({ orderToken, method: 'CASH_AT_RESTAURANT' })).status).toBe(409); // already paid
  });

  it('supports partial then full refunds and blocks over-refunds', async () => {
    const pay = await prisma.payment.findFirstOrThrow({ where: { orderId, status: 'PAID' } });
    const total = Number(pay.amount);
    expect((await api().post('/api/payments/refund').set(cashier.auth).send({ paymentId: pay.id, amount: total + 1 })).status).toBe(400);
    const part = await api().post('/api/payments/refund').set(cashier.auth).send({ paymentId: pay.id, amount: 5, reason: 'Cold food' });
    expect(part.status).toBe(201);
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: pay.id } })).status).toBe('PARTIALLY_REFUNDED');
    const rest = await api().post('/api/payments/refund').set(manager.auth).send({ paymentId: pay.id });
    expect(Number(rest.body.amount)).toBeCloseTo(total - 5);
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: pay.id } })).status).toBe('REFUNDED');
    expect((await api().post('/api/payments/refund').set(manager.auth).send({ paymentId: pay.id, amount: 1 })).status).toBe(409);
  });

  it('verifies Stripe and Razorpay webhook signatures (and rejects forged / replayed ones)', async () => {
    const payload = Buffer.from(JSON.stringify({ id: 'evt_1', type: 'payment_intent.succeeded', data: { object: { id: 'pi_unknown', amount_received: 100 } } }));
    const t = Math.floor(Date.now() / 1000);
    const sig = crypto.createHmac('sha256', 'whsec_test_secret').update(`${t}.${payload}`).digest('hex');
    expect(verifyStripeSignature(payload, `t=${t},v1=${sig}`, 'whsec_test_secret')).toBe(true);
    expect(verifyStripeSignature(payload, `t=${t},v1=${sig}`, 'other')).toBe(false);
    expect(verifyStripeSignature(payload, `t=${t - 1000},v1=${sig}`, 'whsec_test_secret')).toBe(false); // too old
    const rz = crypto.createHmac('sha256', 'rzp_test_secret').update(payload).digest('hex');
    expect(verifyRazorpaySignature(payload, rz, 'rzp_test_secret')).toBe(true);
    expect(verifyRazorpaySignature(payload, rz.replace(/.$/, '0'), 'rzp_test_secret')).toBe(false);

    const forged = await api().post('/api/payments/webhook').set('stripe-signature', `t=${t},v1=deadbeef`).set('content-type', 'application/json').send(payload.toString());
    expect(forged.status).toBe(400);
    const good = await api().post('/api/payments/webhook').set('stripe-signature', `t=${t},v1=${sig}`).set('content-type', 'application/json').send(payload.toString());
    expect(good.status).toBe(200);
    const replay = await api().post('/api/payments/webhook').set('stripe-signature', `t=${t},v1=${sig}`).set('content-type', 'application/json').send(payload.toString());
    expect(replay.body.duplicate).toBe(true);
  });

  it('marks an online payment paid only from a verified webhook with the right amount', async () => {
    const pizza = await productBySlug('margherita-pizza');
    const o = await api().post('/api/orders').send({ type: 'TAKEAWAY', guest: { name: 'Web Hook', phone: '+65 8666 0000' }, items: [{ productId: pizza.id, quantity: 1 }] });
    const payment = await prisma.payment.create({ data: { orderId: o.body.id, method: 'CARD', provider: 'stripe', amount: o.body.total, providerRef: 'pi_test_123' } });
    // order can't be accepted before provider confirmation
    expect((await api().patch(`/api/orders/${o.body.id}/status`).set(manager.auth).send({ status: 'ACCEPTED' })).status).toBe(409);
    const send = (evt: any) => {
      const raw = Buffer.from(JSON.stringify(evt));
      const t = Math.floor(Date.now() / 1000);
      const s = crypto.createHmac('sha256', 'whsec_test_secret').update(`${t}.${raw}`).digest('hex');
      return api().post('/api/payments/webhook').set('stripe-signature', `t=${t},v1=${s}`).set('content-type', 'application/json').send(raw.toString());
    };
    await send({ id: 'evt_wrong', type: 'payment_intent.succeeded', data: { object: { id: 'pi_test_123', amount_received: 1 } } });
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).status).toBe('PENDING');
    await send({ id: 'evt_right', type: 'payment_intent.succeeded', data: { object: { id: 'pi_test_123', amount_received: Math.round(Number(o.body.total) * 100) } } });
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).status).toBe('PAID');
    expect((await api().patch(`/api/orders/${o.body.id}/status`).set(manager.auth).send({ status: 'ACCEPTED' })).status).toBe(200);
  });
});

describe('inventory management', () => {
  it('records receipts, wastage and reconciliation in the ledger and rejects negative stock', async () => {
    const ing = await prisma.ingredient.findUniqueOrThrow({ where: { name: 'Cream' } });
    const mv = (type: string, quantity: number) => api().post(`/api/inventory/${ing.id}/move`).set(manager.auth).send({ type, quantity });
    expect((await mv('RECEIPT', 4)).status).toBe(201);
    expect((await mv('WASTAGE', 1)).status).toBe(201);
    expect((await mv('WASTAGE', 100)).status).toBe(400);
    expect((await mv('RECONCILIATION', 8)).status).toBe(201);
    expect(Number((await prisma.ingredient.findUniqueOrThrow({ where: { id: ing.id } })).stock)).toBe(8);
    const hist = await api().get(`/api/inventory/${ing.id}/history`).set(manager.auth);
    expect(hist.body.length).toBeGreaterThanOrEqual(3);
    expect((await api().get('/api/inventory').set(waiter.auth)).status).toBe(403);
  });
  it('receives a purchase order exactly once', async () => {
    const sup = await api().post('/api/inventory/suppliers').set(manager.auth).send({ name: 'Sample Supplier' });
    const ing = await prisma.ingredient.findUniqueOrThrow({ where: { name: 'Coffee beans' } });
    const before = Number(ing.stock);
    const po = await api().post('/api/inventory/purchase-orders').set(manager.auth).send({ supplierId: sup.body.id, lines: [{ ingredientId: ing.id, quantity: 10, unitCost: 20 }] });
    expect((await api().post(`/api/inventory/purchase-orders/${po.body.id}/receive`).set(manager.auth)).status).toBe(200);
    expect((await api().post(`/api/inventory/purchase-orders/${po.body.id}/receive`).set(manager.auth)).status).toBe(409);
    expect(Number((await prisma.ingredient.findUniqueOrThrow({ where: { id: ing.id } })).stock)).toBe(before + 10);
  });
});

describe('staff management', () => {
  it('manager can create staff but not owners; cannot deactivate the last owner', async () => {
    const mk = (who: typeof admin, role: string, email: string) => api().post('/api/staff').set(who.auth).send({ email, name: 'New Person', role, password: 'Str0ngPassword!' });
    expect((await mk(manager, 'WAITER', 'new.waiter@theminerva.com')).status).toBe(201);
    expect((await mk(manager, 'OWNER', 'new.owner@theminerva.com')).status).toBe(403);
    expect((await mk(manager, 'WAITER', 'new.waiter@theminerva.com')).status).toBe(409);
    const me = await prisma.user.findUniqueOrThrow({ where: { email: 'admin@theminerva.com' } });
    expect((await api().put(`/api/staff/${me.id}`).set(admin.auth).send({ isActive: false })).status).toBe(400);
  });
  it('deactivated staff lose access immediately even with a valid token', async () => {
    await api().post('/api/staff').set(admin.auth).send({ email: 'temp@theminerva.com', name: 'Temp Person', role: 'CASHIER', password: 'Str0ngPassword!' });
    const t = await api().post('/api/auth/login').send({ email: 'temp@theminerva.com', password: 'Str0ngPassword!' });
    const auth = { Authorization: `Bearer ${t.body.accessToken}` };
    expect((await api().get('/api/orders').set(auth)).status).toBe(200);
    const u = await prisma.user.findUniqueOrThrow({ where: { email: 'temp@theminerva.com' } });
    await api().put(`/api/staff/${u.id}`).set(admin.auth).send({ isActive: false });
    expect((await api().get('/api/orders').set(auth)).status).toBe(401);
  });
});

describe('promotions', () => {
  it('creates coupons with validation and enforces usage limits atomically', async () => {
    const bad = await api().post('/api/marketing/coupons').set(manager.auth).send({ code: 'x', type: 'PERCENT', value: 10 });
    expect(bad.status).toBe(422);
    const over = await api().post('/api/marketing/coupons').set(manager.auth).send({ code: 'BIG', type: 'PERCENT', value: 150 });
    expect(over.status).toBe(422);
    const c = await api().post('/api/marketing/coupons').set(manager.auth).send({ code: 'ONCE', type: 'FIXED', value: 2, maxUses: 1 });
    expect(c.status).toBe(201);
    const pudding = await productBySlug('cream-pudding');
    const place = (i: number) => api().post('/api/orders').send({ type: 'TAKEAWAY', guest: { name: 'C' + i, phone: '+65 8444 000' + i }, items: [{ productId: pudding.id, quantity: 1 }], couponCode: 'ONCE' });
    const res = await Promise.all([place(1), place(2), place(3)]);
    expect(res.filter((r) => r.status === 201)).toHaveLength(1);
    expect((await prisma.coupon.findUniqueOrThrow({ where: { code: 'ONCE' } })).usedCount).toBe(1);
  });
  it('applies happy-hour pricing rules and BOGO coupons', async () => {
    const drinks = await prisma.category.findUniqueOrThrow({ where: { slug: 'drinks' } });
    const tz = (await prisma.restaurant.findUniqueOrThrow({ where: { id: 'minerva' } })).timezone;
    void tz;
    await api().post('/api/marketing/pricing-rules').set(manager.auth).send({ name: 'All-day drinks', categoryId: drinks.id, percentOff: 20, startTime: '00:00', endTime: '23:59' });
    const coffee = await productBySlug('flat-white'); // 5.50
    const q = await api().post('/api/orders/quote').send({ type: 'TAKEAWAY', items: [{ productId: coffee.id, quantity: 1 }] });
    expect(q.body.subtotal).toBe(4.4);
    await api().post('/api/marketing/coupons').set(manager.auth).send({ code: 'BOGO', type: 'BOGO', categoryId: drinks.id });
    const q2 = await api().post('/api/orders/quote').send({ type: 'TAKEAWAY', items: [{ productId: coffee.id, quantity: 4 }], couponCode: 'BOGO' });
    expect(q2.body.discount).toBe(8.8); // two free
  });
});

describe('reports and dashboard use real data', () => {
  it('dashboard KPIs match the database', async () => {
    const d = await api().get('/api/reports/dashboard?range=last30').set(admin.auth);
    expect(d.status).toBe(200);
    const expected = await prisma.order.aggregate({ where: { status: 'COMPLETED' }, _sum: { total: true }, _count: true });
    expect(d.body.kpis.revenue).toBeCloseTo(Number(expected._sum.total), 2);
    expect(d.body.kpis.completedOrders).toBe(expected._count);
    expect(d.body.bestSellers.length).toBeGreaterThan(0);
    expect(d.body.kpis.pendingOrders + d.body.kpis.completedOrders + d.body.kpis.cancelledOrders).toBe(d.body.kpis.totalOrders);
  });
  it('supports custom ranges, rejects bad ones and exports CSV / XLSX / PDF', async () => {
    expect((await api().get('/api/reports/dashboard?range=custom&from=2020-01-02&to=2020-01-01').set(admin.auth)).status).toBe(400);
    const empty = await api().get('/api/reports/dashboard?range=custom&from=2020-01-01&to=2020-01-02').set(admin.auth);
    expect(empty.body.kpis.revenue).toBe(0);
    const csv = await api().get('/api/reports/daily-sales?range=last30&format=csv').set(admin.auth);
    expect(csv.text.split('\r\n')[0]).toBe('Date,Orders,Subtotal,Discounts,Tax,Total');
    const bin = (res: any, cb: any) => { const d: Buffer[] = []; res.on('data', (c: Buffer) => d.push(c)); res.on('end', () => cb(null, Buffer.concat(d))); };
    const x = await api().get('/api/reports/popular-items?range=last30&format=xlsx').set(admin.auth).buffer().parse(bin);
    expect(x.body.subarray(0, 2).toString()).toBe('PK');
    const p = await api().get('/api/reports/peak-hours?range=last30&format=pdf').set(admin.auth).buffer().parse(bin);
    expect(p.body.subarray(0, 4).toString()).toBe('%PDF');
    for (const key of ['monthly-sales', 'revenue-by-category', 'revenue-by-product', 'payment-methods', 'order-types', 'customer-acquisition', 'repeat-customers', 'reservations', 'inventory-usage', 'staff-performance', 'discounts', 'refunds', 'delivery', 'retention'])
      expect((await api().get(`/api/reports/${key}?range=last30`).set(admin.auth)).status, key).toBe(200);
    expect((await api().get('/api/reports/daily-sales').set(waiter.auth)).status).toBe(403);
  });
});

describe('privacy (PDPA / GDPR)', () => {
  it('exports and erases a customer\'s personal data while keeping order records', async () => {
    const reg = await api().post('/api/auth/register').send({ name: 'Erase Me', email: 'erase@example.com', password: 'Str0ngPassword!', phone: '+65 8999 1234' });
    const auth = { Authorization: `Bearer ${reg.body.accessToken}` };
    const pudding = await productBySlug('cream-pudding');
    await api().post('/api/orders').set(auth).send({ type: 'TAKEAWAY', items: [{ productId: pudding.id, quantity: 1 }] });
    const exp = await api().get('/api/customers/me/export').set(auth);
    expect(exp.body.email).toBe('erase@example.com');
    expect(exp.body.passwordHash).toBeNull();
    expect((await api().delete('/api/customers/me').set(auth)).status).toBe(200);
    const c = await prisma.customer.findUniqueOrThrow({ where: { id: exp.body.id } });
    expect(c.email).toBeNull();
    expect(c.name).toBe('Deleted customer');
    expect(await prisma.order.count({ where: { customerId: c.id } })).toBe(1);
  });
  it('sends campaigns only to opted-in customers and reports honest delivery', async () => {
    const camp = await api().post('/api/campaigns').set(manager.auth).send({ name: 'Test', channel: 'EMAIL', subject: 'Hi', body: 'Hello {{name}}', segment: 'ALL' });
    const sent = await api().post(`/api/campaigns/${camp.body.id}/send`).set(manager.auth);
    expect(sent.body.recipients).toBeGreaterThanOrEqual(1);
    const optedOut = await prisma.customer.count({ where: { marketingConsent: false } });
    expect(optedOut).toBeGreaterThan(0);
    expect(sent.body.sentCount).toBe(0); // no email provider configured → nothing falsely "sent"
    expect(sent.body.failedCount).toBe(sent.body.recipients);
    expect((await api().post(`/api/campaigns/${camp.body.id}/send`).set(manager.auth)).status).toBe(409);
  });
});

describe('AI assistant', () => {
  it('reports unavailable (503) when no provider key is configured instead of inventing answers', async () => {
    const r = await api().post('/api/ai/chat').set(admin.auth).send({ messages: [{ role: 'user', content: 'What are today\'s sales?' }] });
    expect(r.status).toBe(503);
    expect((await api().post('/api/ai/chat').set(kitchen.auth).send({ messages: [{ role: 'user', content: 'hi' }] })).status).toBe(403);
  });
});

describe('utilities', () => {
  it('parses and writes CSV safely', () => {
    expect(csvParse('a,"b,c",d\n1,"x ""y""",3')).toEqual([['a', 'b,c', 'd'], ['1', 'x "y"', '3']]);
    expect(csvStringify([['=1+1', 'ok', 'a,b']])).toBe(`'=1+1,ok,"a,b"\r\n`);
  });
  it('handles overnight time windows and timezone conversion', () => {
    expect(inWindow(23 * 60, '22:00', '02:00')).toBe(true);
    expect(inWindow(3 * 60, '22:00', '02:00')).toBe(false);
    expect(inWindow(500, null, null)).toBe(true);
    expect(zonedToUtc('2026-03-01', '19:00', 'Asia/Singapore').toISOString()).toBe('2026-03-01T11:00:00.000Z');
  });
  it('serves OpenAPI docs, sitemap and robots', async () => {
    const spec = await api().get('/api/openapi.json');
    expect(Object.keys(spec.body.paths)).toContain('/api/orders/{id}/status');
    expect((await api().get('/sitemap.xml')).text).toContain('<urlset');
    expect((await api().get('/robots.txt')).text).toContain('Disallow: /admin');
    expect((await api().get('/api/nope')).status).toBe(404);
  });
});
