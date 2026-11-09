import { Router } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import { prisma } from '../db.js';
import { attachAuth, clearRefresh, requireCustomer, requirePerm } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { badRequest, notFound, pageQuery, paged, paginate, parse, wrap } from '../lib/http.js';
import { getSettings } from '../lib/settings.js';
import { csvStringify } from '../lib/csv.js';
import { fromCents, toCents } from '../lib/money.js';

export const customerRouter = Router();
const phone = z.string().trim().regex(/^\+?[0-9 ()-]{7,20}$/, 'Enter a valid phone number');

// ───────── self service ─────────
customerRouter.get('/me/profile', attachAuth, requireCustomer, wrap(async (req, res) => {
  const c = await prisma.customer.findUnique({ where: { id: req.customer!.id }, include: { addresses: true, favourites: true } });
  if (!c) throw notFound('Customer');
  const { passwordHash, ...safe } = c;
  const s = (await getSettings()).loyalty;
  const next = [...s.tiers].sort((a, b) => a.minLifetime - b.minLifetime).find((t) => t.minLifetime > c.lifetimePoints);
  res.json({ ...safe, loyalty: { enabled: s.enabled, minRedeemPoints: s.minRedeemPoints, pointValue: s.pointValue, nextTier: next ? { name: next.name, pointsNeeded: next.minLifetime - c.lifetimePoints } : null } });
}));
customerRouter.put('/me/profile', attachAuth, requireCustomer, wrap(async (req, res) => {
  const b = parse(z.object({ name: z.string().trim().min(2).max(80), phone: phone.nullish(), birthday: z.coerce.date().nullish(), preferences: z.string().max(500).nullish(), allergies: z.string().max(500).nullish(), marketingConsent: z.boolean().optional() }).partial(), req.body);
  const cur = await prisma.customer.findUniqueOrThrow({ where: { id: req.customer!.id } });
  const c = await prisma.customer.update({
    where: { id: cur.id },
    data: { ...b, ...(b.marketingConsent !== undefined && b.marketingConsent !== cur.marketingConsent ? { consentAt: new Date(), unsubscribedAt: b.marketingConsent ? null : new Date() } : {}) },
  });
  const { passwordHash, ...safe } = c;
  res.json(safe);
}));
customerRouter.get('/me/orders', attachAuth, requireCustomer, wrap(async (req, res) => {
  const q = parse(pageQuery, req.query);
  const where = { customerId: req.customer!.id };
  const [items, total] = await Promise.all([
    prisma.order.findMany({ where, ...paginate(q), orderBy: { createdAt: 'desc' }, include: { items: true, payments: { select: { status: true, method: true } } } }),
    prisma.order.count({ where }),
  ]);
  res.json(paged(items, total, q));
}));
customerRouter.get('/me/loyalty', attachAuth, requireCustomer, wrap(async (req, res) => {
  const [tx, vouchers] = await Promise.all([
    prisma.loyaltyTransaction.findMany({ where: { customerId: req.customer!.id }, orderBy: { createdAt: 'desc' }, take: 100 }),
    prisma.voucher.findMany({ where: { customerId: req.customer!.id, usedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] } }),
  ]);
  res.json({ transactions: tx, vouchers });
}));
customerRouter.post('/me/redeem', attachAuth, requireCustomer, wrap(async (req, res) => {
  const { points } = parse(z.object({ points: z.number().int().min(1) }), req.body);
  const s = (await getSettings()).loyalty;
  if (!s.enabled) throw badRequest('Loyalty is not enabled');
  if (points < s.minRedeemPoints) throw badRequest(`Minimum redemption is ${s.minRedeemPoints} points`);
  const v = await prisma.$transaction(async (tx) => {
    const r = await tx.customer.updateMany({ where: { id: req.customer!.id, loyaltyPoints: { gte: points } }, data: { loyaltyPoints: { decrement: points } } });
    if (r.count === 0) throw badRequest('Not enough points');
    await tx.loyaltyTransaction.create({ data: { customerId: req.customer!.id, points: -points, reason: 'REDEEM' } });
    return tx.voucher.create({ data: { customerId: req.customer!.id, code: 'V-' + crypto.randomBytes(4).toString('hex').toUpperCase(), amount: fromCents(toCents(points * s.pointValue)), expiresAt: new Date(Date.now() + 90 * 864e5) } });
  });
  res.status(201).json(v);
}));
customerRouter.post('/me/addresses', attachAuth, requireCustomer, wrap(async (req, res) => {
  const b = parse(z.object({ label: z.string().max(30).optional(), line1: z.string().trim().min(3).max(200), postalCode: z.string().max(12).optional(), notes: z.string().max(200).optional() }), req.body);
  res.status(201).json(await prisma.customerAddress.create({ data: { ...b, customerId: req.customer!.id } }));
}));
customerRouter.delete('/me/addresses/:id', attachAuth, requireCustomer, wrap(async (req, res) => {
  await prisma.customerAddress.deleteMany({ where: { id: req.params.id, customerId: req.customer!.id } });
  res.json({ ok: true });
}));
customerRouter.post('/me/favourites/:productId', attachAuth, requireCustomer, wrap(async (req, res) => {
  const key = { customerId_productId: { customerId: req.customer!.id, productId: req.params.productId } };
  const has = await prisma.favourite.findUnique({ where: key });
  if (has) await prisma.favourite.delete({ where: key }); else await prisma.favourite.create({ data: { customerId: req.customer!.id, productId: req.params.productId } });
  res.json({ favourite: !has });
}));
/** PDPA/GDPR: erase my personal data. Orders are kept for accounting but detached from identity. */
customerRouter.delete('/me', attachAuth, requireCustomer, wrap(async (req, res) => {
  await eraseCustomer(req.customer!.id);
  clearRefresh(res);
  res.json({ ok: true });
}));
customerRouter.get('/me/export', attachAuth, requireCustomer, wrap(async (req, res) => {
  const c = await prisma.customer.findUnique({ where: { id: req.customer!.id }, include: { addresses: true, orders: { include: { items: true } }, reservations: true, loyaltyTx: true } });
  if (c) c.passwordHash = null;
  res.attachment('my-data.json').json(c);
}));

async function eraseCustomer(id: string) {
  await prisma.$transaction([
    prisma.customerAddress.deleteMany({ where: { customerId: id } }),
    prisma.favourite.deleteMany({ where: { customerId: id } }),
    prisma.customerRefreshToken.deleteMany({ where: { customerId: id } }),
    prisma.order.updateMany({ where: { customerId: id }, data: { guestName: 'Deleted customer', guestPhone: null, guestEmail: null, deliveryAddress: null } }),
    prisma.reservation.updateMany({ where: { customerId: id }, data: { name: 'Deleted customer', phone: '-', email: null } }),
    prisma.customer.update({ where: { id }, data: { name: 'Deleted customer', email: null, phone: null, passwordHash: null, birthday: null, preferences: null, allergies: null, tags: [], marketingConsent: false, unsubscribedAt: new Date() } }),
  ]);
}

// ───────── staff CRM ─────────
const SEGMENTS = ['NEW', 'RETURNING', 'VIP', 'INACTIVE', 'HIGH_SPEND', 'BIRTHDAY'] as const;
export async function segmentIds(segment: string): Promise<string[] | null> {
  const day = 864e5;
  if (segment === 'ALL') return null;
  if (segment === 'NEW') return (await prisma.customer.findMany({ where: { createdAt: { gte: new Date(Date.now() - 30 * day) } }, select: { id: true } })).map((c) => c.id);
  if (segment === 'VIP') return (await prisma.customer.findMany({ where: { tier: { not: 'Member' } }, select: { id: true } })).map((c) => c.id);
  if (segment === 'INACTIVE') return (await prisma.customer.findMany({ where: { lastOrderAt: { lt: new Date(Date.now() - 60 * day) } }, select: { id: true } })).map((c) => c.id);
  if (segment === 'BIRTHDAY') {
    const rows = await prisma.$queryRaw<Array<{ id: string }>>`SELECT id FROM "Customer" WHERE birthday IS NOT NULL AND EXTRACT(MONTH FROM birthday) = EXTRACT(MONTH FROM now())`;
    return rows.map((r) => r.id);
  }
  const g = await prisma.order.groupBy({ by: ['customerId'], where: { customerId: { not: null }, status: 'COMPLETED' }, _count: true, _sum: { total: true } });
  if (segment === 'RETURNING') return g.filter((x) => x._count >= 2).map((x) => x.customerId!);
  if (segment === 'HIGH_SPEND') return g.filter((x) => Number(x._sum.total) >= 200).map((x) => x.customerId!);
  return null;
}

customerRouter.get('/', attachAuth, requirePerm('customers.view'), wrap(async (req, res) => {
  const q = parse(pageQuery.extend({ segment: z.string().optional() }), req.query);
  const ids = q.segment && SEGMENTS.includes(q.segment as any) ? await segmentIds(q.segment) : null;
  const where: any = {};
  if (ids) where.id = { in: ids };
  if (q.q) where.OR = [{ name: { contains: q.q, mode: 'insensitive' } }, { email: { contains: q.q, mode: 'insensitive' } }, { phone: { contains: q.q } }];
  const [items, total] = await Promise.all([
    prisma.customer.findMany({ where, ...paginate(q), orderBy: { createdAt: 'desc' }, select: { id: true, name: true, email: true, phone: true, loyaltyPoints: true, tier: true, tags: true, createdAt: true, lastOrderAt: true, marketingConsent: true } }),
    prisma.customer.count({ where }),
  ]);
  const stats = await prisma.order.groupBy({ by: ['customerId'], where: { customerId: { in: items.map((i) => i.id) }, status: 'COMPLETED' }, _count: true, _sum: { total: true } });
  res.json(paged(items.map((c) => { const s = stats.find((x) => x.customerId === c.id); return { ...c, orders: s?._count ?? 0, totalSpend: Number(s?._sum.total ?? 0), avgSpend: s ? Number(s._sum.total) / s._count : 0 }; }), total, q));
}));
customerRouter.get('/export.csv', attachAuth, requirePerm('customers.manage'), wrap(async (req, res) => {
  const cs = await prisma.customer.findMany({ orderBy: { createdAt: 'asc' } });
  await audit(req, 'customers.export', 'Customer', undefined, { count: cs.length });
  res.type('text/csv').attachment('customers.csv').send(csvStringify([['name', 'email', 'phone', 'tier', 'points', 'marketing_consent', 'created'], ...cs.map((c) => [c.name, c.email, c.phone, c.tier, c.loyaltyPoints, c.marketingConsent, c.createdAt.toISOString()])]));
}));
customerRouter.get('/:id', attachAuth, requirePerm('customers.view'), wrap(async (req, res) => {
  const c = await prisma.customer.findUnique({ where: { id: req.params.id }, include: { addresses: true, orders: { orderBy: { createdAt: 'desc' }, take: 20, select: { id: true, number: true, status: true, total: true, createdAt: true, type: true } }, loyaltyTx: { orderBy: { createdAt: 'desc' }, take: 20 }, reservations: { orderBy: { startAt: 'desc' }, take: 10 } } });
  if (!c) throw notFound('Customer');
  const { passwordHash, ...safe } = c;
  const agg = await prisma.order.aggregate({ where: { customerId: c.id, status: 'COMPLETED' }, _sum: { total: true }, _avg: { total: true }, _count: true });
  res.json({ ...safe, stats: { orders: agg._count, totalSpend: agg._sum.total, avgSpend: agg._avg.total } });
}));
customerRouter.put('/:id', attachAuth, requirePerm('customers.manage'), wrap(async (req, res) => {
  const b = parse(z.object({ name: z.string().trim().min(2).max(80), phone: phone.nullish(), email: z.string().email().nullish(), tags: z.array(z.string().max(30)).max(20), preferences: z.string().max(500).nullish(), allergies: z.string().max(500).nullish(), birthday: z.coerce.date().nullish() }).partial(), req.body);
  const c = await prisma.customer.update({ where: { id: req.params.id }, data: b }).catch(() => null);
  if (!c) throw notFound('Customer');
  await audit(req, 'customer.update', 'Customer', c.id);
  const { passwordHash, ...safe } = c;
  res.json(safe);
}));
customerRouter.post('/:id/points', attachAuth, requirePerm('customers.manage'), wrap(async (req, res) => {
  const b = parse(z.object({ points: z.number().int().min(-100000).max(100000).refine((n) => n !== 0), note: z.string().max(200).optional() }), req.body);
  const c = await prisma.$transaction(async (tx) => {
    if (b.points < 0) {
      const r = await tx.customer.updateMany({ where: { id: req.params.id, loyaltyPoints: { gte: -b.points } }, data: { loyaltyPoints: { increment: b.points } } });
      if (!r.count) throw badRequest('Customer does not have that many points');
    } else await tx.customer.update({ where: { id: req.params.id }, data: { loyaltyPoints: { increment: b.points } } });
    await tx.loyaltyTransaction.create({ data: { customerId: req.params.id, points: b.points, reason: 'ADJUST' } });
    return tx.customer.findUniqueOrThrow({ where: { id: req.params.id } });
  });
  await audit(req, 'customer.points_adjust', 'Customer', c.id, b);
  res.json({ loyaltyPoints: c.loyaltyPoints });
}));
customerRouter.delete('/:id', attachAuth, requirePerm('customers.manage'), wrap(async (req, res) => {
  await eraseCustomer(req.params.id);
  await audit(req, 'customer.erase', 'Customer', req.params.id);
  res.json({ ok: true });
}));
