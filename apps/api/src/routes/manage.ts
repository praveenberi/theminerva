import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import QRCode from 'qrcode';
import { HttpError, env, parse, prisma } from '../lib/core';
import { assertFeature, getEntitlements, requireFeature } from '../lib/billing';
import { minutesOf } from '../lib/promo';
import { csvText } from '../lib/csv';
import { hasActiveAccount } from '../lib/paymentAccounts';
import { customersWithStats } from '../lib/segments';
import { MANAGE, STAFF, authenticate, requireRole, rid, wrap } from '../middleware/auth';

export const manage = Router();
manage.use(authenticate);

// ---------- restaurant profile ----------
const profileSchema = z.object({
  name: z.string().trim().min(2).max(80),
  description: z.string().max(500),
  category: z.string().max(40),
  address: z.string().max(200),
  phone: z.string().max(30),
  whatsapp: z.string().max(30),
  currency: z.string().length(3).toUpperCase(),
  taxPercent: z.number().min(0).max(50),
  serviceChargePercent: z.number().min(0).max(30),
  deliveryFeeCents: z.number().int().min(0),
  minDeliveryCents: z.number().int().min(0),
  orderTypes: z.array(z.enum(['DINE_IN', 'TAKEAWAY', 'DELIVERY'])).min(1),
  acceptGuestOrders: z.boolean(),
  published: z.boolean(),
  onlinePayments: z.boolean(),
  loyaltyEnabled: z.boolean(),
  bannerText: z.string().max(160),
  utcOffsetMinutes: z.number().int().min(-720).max(840), // outlet's clock, used for happy-hour offers and birthdays
  openTime: z.string().regex(/^\d{2}:\d{2}$/),
  closeTime: z.string().regex(/^\d{2}:\d{2}$/),
  reservationSlotMinutes: z.number().int().min(30).max(240),
});

manage.get('/restaurant', wrap(async (req, res) => {
  const r = await prisma.restaurant.findUnique({ where: { id: rid(req) } });
  res.json(r);
}));

manage.put('/restaurant', requireRole('OWNER'), wrap(async (req, res) => {
  const d = parse(profileSchema.partial(), req.body);
  if (d.onlinePayments === true) {
    await assertFeature(req.user!.tenantId, 'online_payments');
    if (!(await hasActiveAccount(rid(req)))) throw new HttpError(409, 'Connect your own payment provider account first (Settings → Online payments).', 'no_payment_account');
  }
  if (d.loyaltyEnabled === true) await assertFeature(req.user!.tenantId, 'loyalty');
  const r = await prisma.restaurant.update({ where: { id: rid(req) }, data: d });
  await prisma.auditLog.create({ data: { restaurantId: r.id, actorId: req.user!.id, action: 'restaurant.update', detail: Object.keys(d) } });
  res.json(r);
}));

// ---------- categories ----------
manage.get('/categories', wrap(async (req, res) => {
  res.json(await prisma.category.findMany({ where: { restaurantId: rid(req) }, orderBy: { sort: 'asc' } }));
}));

manage.post('/categories', requireRole(...MANAGE), wrap(async (req, res) => {
  const d = parse(z.object({ name: z.string().trim().min(1).max(60) }), req.body);
  const max = await prisma.category.aggregate({ where: { restaurantId: rid(req) }, _max: { sort: true } });
  res.status(201).json(await prisma.category.create({ data: { restaurantId: rid(req), name: d.name, sort: (max._max.sort ?? 0) + 1 } }));
}));

manage.put('/categories/order', requireRole(...MANAGE), wrap(async (req, res) => {
  const d = parse(z.object({ ids: z.array(z.string()) }), req.body);
  const own = await prisma.category.count({ where: { restaurantId: rid(req), id: { in: d.ids } } });
  if (own !== d.ids.length) throw new HttpError(400, 'Unknown category in list', 'validation');
  await prisma.$transaction(d.ids.map((id, i) => prisma.category.update({ where: { id }, data: { sort: i } })));
  res.json({ ok: true });
}));

manage.patch('/categories/:id', requireRole(...MANAGE), wrap(async (req, res) => {
  const d = parse(z.object({ name: z.string().trim().min(1).max(60) }), req.body);
  const r = await prisma.category.updateMany({ where: { id: req.params.id, restaurantId: rid(req) }, data: d });
  if (!r.count) throw new HttpError(404, 'Not found', 'not_found');
  res.json({ ok: true });
}));

manage.delete('/categories/:id', requireRole(...MANAGE), wrap(async (req, res) => {
  const r = await prisma.category.deleteMany({ where: { id: req.params.id, restaurantId: rid(req) } });
  if (!r.count) throw new HttpError(404, 'Not found', 'not_found');
  res.status(204).end();
}));

// ---------- products ----------
const option = z.object({ id: z.string().min(1).max(40), name: z.string().trim().min(1).max(60), priceCents: z.number().int().min(0) });
const productSchema = z.object({
  categoryId: z.string(),
  name: z.string().trim().min(1).max(100),
  description: z.string().max(600).default(''),
  priceCents: z.number().int().min(0),
  discountPriceCents: z.number().int().min(0).nullable().optional(),
  imageUrl: z.string().max(500).refine(okImageRef, 'Use an uploaded image or an http(s) link').nullable().optional().or(z.literal('').transform(() => null)),
  available: z.boolean().default(true),
  dietary: z.array(z.enum(['VEG', 'VEGAN', 'NON_VEG', 'GLUTEN_FREE'])).default([]),
  allergens: z.array(z.string().max(30)).max(14).default([]),
  prepMinutes: z.number().int().min(0).max(240).default(15),
  variants: z.array(option).max(20).default([]),
  addons: z.array(option).max(30).default([]),
}).refine((p) => p.discountPriceCents == null || p.discountPriceCents <= p.priceCents, {
  message: 'Discounted price cannot exceed the price', path: ['discountPriceCents'],
});

const IMAGE_PATH = /^\/api\/public\/images\/([a-z0-9]{20,40})$/;
function okImageRef(u: string): boolean {
  if (IMAGE_PATH.test(u)) return true;
  try { return /^https?:$/.test(new URL(u).protocol); } catch { return false; }
}
/** Deletes an uploaded photo once no menu item uses it any more (copied menus and duplicated items share one photo). */
async function releaseImage(url: string | null | undefined, restaurantId: string) {
  const m = url ? IMAGE_PATH.exec(url) : null;
  if (!m || (await prisma.product.count({ where: { imageUrl: url } }))) return;
  await prisma.menuImage.deleteMany({ where: { id: m[1], restaurantId } });
}

/** What the first bytes say the file is. The declared content type is never trusted. */
function sniffImage(b: Buffer): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  if (b.length > 12 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 12 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}
const MAX_IMAGES_PER_RESTAURANT = Number(process.env.MAX_MENU_IMAGES ?? 300);
const imageLimit = rateLimit({
  windowMs: 60_000, limit: Number(process.env.IMAGE_UPLOAD_LIMIT ?? 40), standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => req.user?.id ?? req.ip ?? 'anon', message: { error: { code: 'rate_limited', message: 'Too many uploads. Try again in a minute.' } },
});

manage.post('/images', requireRole(...MANAGE), imageLimit, wrap(async (req, res) => {
  const body = req.body;
  if (!Buffer.isBuffer(body) || !body.length) throw new HttpError(400, 'Send the picture as a JPEG, PNG or WebP file', 'validation');
  const contentType = sniffImage(body);
  if (!contentType) throw new HttpError(400, 'Only JPEG, PNG or WebP pictures are accepted', 'validation');
  if ((await prisma.menuImage.count({ where: { restaurantId: rid(req) } })) >= MAX_IMAGES_PER_RESTAURANT)
    throw new HttpError(409, 'You have reached the picture limit. Delete menu items you no longer use, or remove their pictures.', 'limit_reached');
  const img = await prisma.menuImage.create({ data: { restaurantId: rid(req), contentType, data: body }, select: { id: true } });
  res.status(201).json({ url: `/api/public/images/${img.id}` });
}));

async function assertCategory(restaurantId: string, categoryId: string) {
  if (!(await prisma.category.count({ where: { id: categoryId, restaurantId } })))
    throw new HttpError(400, 'Category not found', 'validation', { categoryId: ['Unknown category'] });
}

manage.get('/products', wrap(async (req, res) => {
  res.json(await prisma.product.findMany({ where: { restaurantId: rid(req) }, orderBy: [{ sort: 'asc' }, { createdAt: 'asc' }] }));
}));

manage.post('/products', requireRole(...MANAGE), wrap(async (req, res) => {
  await assertProductRoom(req.user!.tenantId!, rid(req), 1);
  const d = parse(productSchema, req.body);
  await assertCategory(rid(req), d.categoryId);
  res.status(201).json(await prisma.product.create({ data: { ...d, imageUrl: d.imageUrl ?? null, restaurantId: rid(req) } }));
}));

manage.put('/products/:id', requireRole(...MANAGE), wrap(async (req, res) => {
  const d = parse(productSchema, req.body);
  await assertCategory(rid(req), d.categoryId);
  const before = await prisma.product.findFirst({ where: { id: req.params.id, restaurantId: rid(req) }, select: { imageUrl: true } });
  const r = await prisma.product.updateMany({ where: { id: req.params.id, restaurantId: rid(req) }, data: { ...d, imageUrl: d.imageUrl ?? null } });
  if (!r.count) throw new HttpError(404, 'Not found', 'not_found');
  if (before?.imageUrl && before.imageUrl !== (d.imageUrl ?? null)) await releaseImage(before.imageUrl, rid(req));
  res.json(await prisma.product.findUnique({ where: { id: req.params.id } }));
}));

manage.patch('/products/:id/availability', requireRole(...STAFF), wrap(async (req, res) => {
  const d = parse(z.object({ available: z.boolean() }), req.body);
  const r = await prisma.product.updateMany({ where: { id: req.params.id, restaurantId: rid(req) }, data: d });
  if (!r.count) throw new HttpError(404, 'Not found', 'not_found');
  res.json({ ok: true });
}));

manage.post('/products/:id/duplicate', requireRole(...MANAGE), wrap(async (req, res) => {
  await assertProductRoom(req.user!.tenantId!, rid(req), 1);
  const p = await prisma.product.findFirst({ where: { id: req.params.id, restaurantId: rid(req) } });
  if (!p) throw new HttpError(404, 'Not found', 'not_found');
  const { id: _id, createdAt: _c, ...rest } = p;
  res.status(201).json(await prisma.product.create({ data: { ...rest, name: `${p.name} (copy)`, variants: p.variants as any, addons: p.addons as any } }));
}));

manage.delete('/products/:id', requireRole(...MANAGE), wrap(async (req, res) => {
  const before = await prisma.product.findFirst({ where: { id: req.params.id, restaurantId: rid(req) }, select: { imageUrl: true } });
  const r = await prisma.product.deleteMany({ where: { id: req.params.id, restaurantId: rid(req) } });
  if (!r.count) throw new HttpError(404, 'Not found', 'not_found');
  await releaseImage(before?.imageUrl, rid(req));
  res.status(204).end();
}));

// CSV export / import (columns: category,name,description,price,available)
manage.get('/menu/export.csv', wrap(async (req, res) => {
  const cats = await prisma.category.findMany({ where: { restaurantId: rid(req) }, include: { products: true }, orderBy: { sort: 'asc' } });
  const rows = ['category,name,description,price,available'];
  for (const c of cats) for (const p of c.products)
    rows.push([c.name, p.name, p.description, (p.priceCents / 100).toFixed(2), String(p.available)].map(csvText).join(','));
  res.type('text/csv').attachment('menu.csv').send(rows.join('\n'));
}));

function parseCsv(text: string): string[][] {
  const out: string[][] = []; let row: string[] = []; let cell = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); cell = ''; if (row.some(Boolean)) out.push(row); row = []; }
    else cell += ch;
  }
  row.push(cell); if (row.some(Boolean)) out.push(row);
  return out;
}

manage.post('/menu/import', requireRole(...MANAGE), wrap(async (req, res) => {
  const { csv } = parse(z.object({ csv: z.string().min(1).max(500_000) }), req.body);
  const rows = parseCsv(csv).slice(1);
  await assertProductRoom(req.user!.tenantId!, rid(req), rows.length);
  const restaurantId = rid(req);
  const errors: string[] = []; let created = 0;
  await prisma.$transaction(async (tx) => {
    for (const [i, r] of rows.entries()) {
      const [category, name, description = '', price, available = 'true'] = r.map((s) => s.trim());
      const cents = Math.round(parseFloat(price) * 100);
      if (!category || !name || !Number.isFinite(cents) || cents < 0) { errors.push(`Row ${i + 2}: invalid category, name or price`); continue; }
      let cat = await tx.category.findFirst({ where: { restaurantId, name: category } });
      if (!cat) cat = await tx.category.create({ data: { restaurantId, name: category, sort: 999 } });
      await tx.product.create({ data: { restaurantId, categoryId: cat.id, name, description, priceCents: cents, available: available !== 'false' } });
      created++;
    }
  });
  res.json({ created, errors });
}));

// ---------- tables & QR ----------
manage.get('/tables', wrap(async (req, res) => {
  res.json(await prisma.diningTable.findMany({ where: { restaurantId: rid(req) }, orderBy: { label: 'asc' } }));
}));

manage.post('/tables', requireRole(...MANAGE), wrap(async (req, res) => {
  const d = parse(z.object({ label: z.string().trim().min(1).max(20), capacity: z.number().int().min(1).max(50) }), req.body);
  try {
    res.status(201).json(await prisma.diningTable.create({ data: { ...d, restaurantId: rid(req) } }));
  } catch (e: any) {
    if (e.code === 'P2002') throw new HttpError(409, 'A table with that label exists', 'duplicate');
    throw e;
  }
}));

manage.delete('/tables/:id', requireRole(...MANAGE), wrap(async (req, res) => {
  const r = await prisma.diningTable.deleteMany({ where: { id: req.params.id, restaurantId: rid(req) } });
  if (!r.count) throw new HttpError(404, 'Not found', 'not_found');
  res.status(204).end();
}));

manage.get('/qr', wrap(async (req, res) => {
  const q = parse(z.object({ tableId: z.string().optional(), format: z.enum(['png', 'svg']).default('png') }), req.query);
  const r = await prisma.restaurant.findUniqueOrThrow({ where: { id: rid(req) } });
  let url = `${env.webOrigin}/r/${r.slug}`;
  if (q.tableId) {
    const t = await prisma.diningTable.findFirst({ where: { id: q.tableId, restaurantId: r.id } });
    if (!t) throw new HttpError(404, 'Table not found', 'not_found');
    url += `?table=${encodeURIComponent(t.label)}`;
  }
  if (q.format === 'svg') return void res.type('image/svg+xml').send(await QRCode.toString(url, { type: 'svg', margin: 2 }));
  res.type('image/png').send(await QRCode.toBuffer(url, { margin: 2, width: 600 }));
}));

// ---------- coupons ----------
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM');
const couponSchema = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{3,20}$/),
  type: z.enum(['PERCENT', 'FIXED', 'BOGO']),
  value: z.number().int().min(1),
  minSubtotalCents: z.number().int().min(0).default(0),
  usageLimit: z.number().int().min(1).nullable().optional(),
  expiresAt: z.string().datetime().nullable().optional(),
  active: z.boolean().default(true),
  categoryId: z.string().nullable().optional(), // limits the discount to one category
  daysOfWeek: z.array(z.number().int().min(0).max(6)).max(7).default([]), // happy hour: 0 = Sunday
  startTime: hhmm.nullable().optional(),
  endTime: hhmm.nullable().optional(),
  customerPhone: z.string().trim().regex(/^[+\d][\d\s-]{6,18}$/).nullable().optional(), // offer for one customer
}).refine((c) => c.type !== 'PERCENT' || c.value <= 100, { message: 'Percent must be ≤ 100', path: ['value'] })
  .refine((c) => !!c.startTime === !!c.endTime, { message: 'Set both start and end time, or neither', path: ['startTime'] })
  .refine((c) => !c.startTime || c.startTime !== c.endTime, { message: 'Start and end must differ', path: ['endTime'] });

manage.get('/coupons', requireRole(...MANAGE), requireFeature('promotions'), wrap(async (req, res) => {
  res.json(await prisma.coupon.findMany({ where: { restaurantId: rid(req) }, orderBy: { code: 'asc' } }));
}));

manage.post('/coupons', requireRole(...MANAGE), requireFeature('promotions'), wrap(async (req, res) => {
  const { startTime, endTime, ...d } = parse(couponSchema, req.body);
  if (d.categoryId && !(await prisma.category.count({ where: { id: d.categoryId, restaurantId: rid(req) } })))
    throw new HttpError(400, 'Unknown category', 'validation', { categoryId: ['Unknown category'] });
  try {
    res.status(201).json(await prisma.coupon.create({
      data: {
        ...d, expiresAt: d.expiresAt ? new Date(d.expiresAt) : null, restaurantId: rid(req),
        startMinute: startTime ? minutesOf(startTime) : null, endMinute: endTime ? minutesOf(endTime) : null,
      },
    }));
  } catch (e: any) {
    if (e.code === 'P2002') throw new HttpError(409, 'Coupon code already exists', 'duplicate');
    throw e;
  }
}));

manage.patch('/coupons/:id', requireRole(...MANAGE), requireFeature('promotions'), wrap(async (req, res) => {
  const d = parse(z.object({ active: z.boolean() }), req.body);
  const r = await prisma.coupon.updateMany({ where: { id: req.params.id, restaurantId: rid(req) }, data: d });
  if (!r.count) throw new HttpError(404, 'Not found', 'not_found');
  res.json({ ok: true });
}));

manage.delete('/coupons/:id', requireRole(...MANAGE), requireFeature('promotions'), wrap(async (req, res) => {
  await prisma.coupon.deleteMany({ where: { id: req.params.id, restaurantId: rid(req) } });
  res.status(204).end();
}));

// ---------- customers ----------
manage.get('/customers', requireRole(...MANAGE), requireFeature('crm'), wrap(async (req, res) => {
  const all = await customersWithStats(rid(req), 500);
  res.json(all.map(({ unsubscribeToken: _t, ...c }) => c)); // the unsubscribe token is a secret link, never listed
}));

/** A plan may cap the menu size per outlet (null = unlimited). `adding` is how many items this request would create. */
async function assertProductRoom(tenantId: string, restaurantId: string, adding: number) {
  const { limits, operational } = await getEntitlements(tenantId);
  if (!operational) throw new HttpError(402, 'Your subscription is not active. Renew it in Billing to continue.', 'subscription_inactive');
  if (limits.maxProducts == null) return;
  const have = await prisma.product.count({ where: { restaurantId } });
  if (have + adding > limits.maxProducts)
    throw new HttpError(402, `Your plan allows ${limits.maxProducts} menu items per outlet (you have ${have}). Upgrade in Billing to add more.`, 'limit_reached', { limit: [String(limits.maxProducts)] });
}
