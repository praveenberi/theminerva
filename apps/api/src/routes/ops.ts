import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { HttpError, parse, prisma } from '../lib/core';
import { canTransition } from '../lib/pricing';
import { rewardCompletedOrder } from '../lib/loyalty';
import { hasFeature, requireFeature } from '../lib/billing';
import { clearAuthCache } from '../middleware/auth';
import { MANAGE, STAFF, authenticate, requireRole, rid, wrap } from '../middleware/auth';

export const ops = Router();
ops.use(authenticate);

/** Consumes ingredients per recipe when an order completes. The ledger's unique (order, ingredient, reason) key makes this idempotent. */
async function deductStock(tx: Prisma.TransactionClient, orderId: string, restaurantId: string, actorId: string) {
  const items = await tx.orderItem.findMany({ where: { orderId, productId: { not: null } }, select: { productId: true, quantity: true } });
  if (!items.length) return;
  const recipes = await tx.recipeItem.findMany({ where: { productId: { in: items.map((i) => i.productId!) } } });
  const use = new Map<string, Prisma.Decimal>();
  for (const it of items)
    for (const r of recipes.filter((x) => x.productId === it.productId))
      use.set(r.ingredientId, (use.get(r.ingredientId) ?? new Prisma.Decimal(0)).plus(new Prisma.Decimal(r.qty).times(it.quantity)));
  for (const [ingredientId, amount] of use) {
    await tx.stockMovement.create({ data: { restaurantId, ingredientId, delta: amount.neg(), reason: 'ORDER', orderId, actorId } });
    await tx.ingredient.update({ where: { id: ingredientId }, data: { stockQty: { decrement: amount } } });
  }
}

// ---------- orders ----------
const ACTIVE = ['NEW', 'ACCEPTED', 'PREPARING', 'READY', 'OUT_FOR_DELIVERY', 'SERVED'] as const;

ops.get('/orders', requireRole(...STAFF), wrap(async (req, res) => {
  const q = parse(z.object({
    status: z.string().optional(), type: z.enum(['DINE_IN', 'TAKEAWAY', 'DELIVERY']).optional(),
    q: z.string().max(60).optional(), active: z.enum(['1']).optional(),
    page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(50),
  }), req.query);
  const where: Prisma.OrderWhereInput = { restaurantId: rid(req) };
  if (q.status) where.status = q.status as any;
  else if (q.active) where.status = { in: [...ACTIVE] };
  if (q.type) where.type = q.type;
  if (q.q) {
    const n = Number(q.q.replace('#', ''));
    where.OR = [
      { customerName: { contains: q.q, mode: 'insensitive' } }, { customerPhone: { contains: q.q } },
      ...(Number.isInteger(n) ? [{ number: n }] : []),
    ];
  }
  const [total, items] = await Promise.all([
    prisma.order.count({ where }),
    prisma.order.findMany({
      where, include: { items: { orderBy: { id: 'asc' } }, table: { select: { label: true } }, deliveryPartner: { select: { id: true, name: true, phone: true } }, deliveryZone: { select: { name: true } } },
      orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize,
    }),
  ]);
  // least privilege: the kitchen needs what to cook, not who to call or where they live
  const safe = req.user!.role === 'KITCHEN' ? items.map(({ customerPhone: _p, address: _a, ...o }) => o) : items;
  res.json({ total, page: q.page, items: safe });
}));

const ROLE_STATUSES: Record<string, string[]> = {
  KITCHEN: ['ACCEPTED', 'PREPARING', 'READY'],
  WAITER: ['SERVED', 'OUT_FOR_DELIVERY', 'COMPLETED'], // the kitchen accepts and cooks; floor staff take over once the food is ready
};

ops.patch('/orders/:id/status', requireRole(...STAFF), wrap(async (req, res) => {
  const { status } = parse(z.object({ status: z.enum(['ACCEPTED', 'PREPARING', 'READY', 'OUT_FOR_DELIVERY', 'SERVED', 'COMPLETED', 'CANCELLED']) }), req.body);
  const role = req.user!.role;
  if (role in ROLE_STATUSES && !ROLE_STATUSES[role].includes(status)) throw new HttpError(403, `${role === 'KITCHEN' ? 'Kitchen accounts' : 'Waiter accounts'} cannot set orders to ${status.toLowerCase().replace(/_/g, ' ')}`, 'forbidden');
  // ingredients are only consumed while the plan includes inventory
  const stockTracked = status === 'COMPLETED' && (await hasFeature(req.user!.tenantId!, 'inventory'));
  const out = await prisma.$transaction(async (tx) => {
    const o = await tx.order.findFirst({ where: { id: req.params.id, restaurantId: rid(req) } });
    if (!o) throw new HttpError(404, 'Order not found', 'not_found');
    if (!canTransition(o.status, status)) throw new HttpError(409, `Cannot move order from ${o.status} to ${status}`, 'bad_transition');
    if (status === 'OUT_FOR_DELIVERY' && o.type !== 'DELIVERY') throw new HttpError(409, 'Only delivery orders go out for delivery', 'bad_transition');
    if (status === 'OUT_FOR_DELIVERY' && !o.deliveryPartnerId) throw new HttpError(409, 'Assign a delivery partner first', 'partner_required');
    // an order is only finished once it has been paid (cash orders are marked paid by staff, online orders by the provider's confirmation)
    if (status === 'COMPLETED' && o.paymentStatus === 'UNPAID') throw new HttpError(409, 'Record the payment before completing this order', 'payment_required');
    if (status === 'SERVED' && o.type !== 'DINE_IN') throw new HttpError(409, 'Only dine-in orders are served', 'bad_transition');
    // conditional update guards against two staff members racing on the same order
    const upd = await tx.order.updateMany({ where: { id: o.id, status: o.status }, data: { status } });
    if (!upd.count) throw new HttpError(409, 'Order was updated by someone else', 'conflict');
    await tx.orderStatusHistory.create({ data: { orderId: o.id, status, actorId: req.user!.id } });
    if (status === 'COMPLETED') {
      // reachable once because COMPLETED is terminal; the ledger's unique keys are a second guard
      await rewardCompletedOrder(tx, o.id);
      if (stockTracked) await deductStock(tx, o.id, o.restaurantId, req.user!.id);
    }
    if (status === 'CANCELLED' && o.couponCode) {
      await tx.coupon.updateMany({ where: { restaurantId: o.restaurantId, code: o.couponCode, usedCount: { gt: 0 } }, data: { usedCount: { decrement: 1 } } });
    }
    return tx.order.findUnique({ where: { id: o.id } });
  });
  res.json(out);
}));

ops.patch('/orders/:id/payment', requireRole(...MANAGE, 'WAITER'), wrap(async (req, res) => {
  const { paymentStatus } = parse(z.object({ paymentStatus: z.enum(['PAID', 'REFUNDED']) }), req.body);
  if (paymentStatus === 'REFUNDED' && req.user!.role === 'WAITER') throw new HttpError(403, 'Refunds need a manager', 'forbidden');
  if (paymentStatus === 'PAID' && req.user!.role === 'WAITER') {
    // a waiter takes payment once the food is out: after serving a table, or when a takeaway/delivery order is ready
    const o = await prisma.order.findFirst({ where: { id: req.params.id, restaurantId: rid(req) }, select: { status: true, type: true } });
    const ok = o && (['SERVED', 'OUT_FOR_DELIVERY'].includes(o.status) || (o.status === 'READY' && o.type !== 'DINE_IN'));
    if (o && !ok) throw new HttpError(409, 'Payment can be recorded once the order has been served', 'bad_transition');
  }
  const from = paymentStatus === 'PAID' ? 'UNPAID' : 'PAID';
  const r = await prisma.order.updateMany({ where: { id: req.params.id, restaurantId: rid(req), paymentMethod: 'CASH', paymentStatus: from, ...(paymentStatus === 'PAID' ? { status: { not: 'CANCELLED' } } : {}) }, data: { paymentStatus } });
  if (!r.count) throw new HttpError(409, `Not a cash order that is ${from.toLowerCase()} (online payments are refunded via /payments/refund)`, 'bad_transition');
  await prisma.auditLog.create({ data: { restaurantId: rid(req), actorId: req.user!.id, action: `order.payment.${paymentStatus.toLowerCase()}`, detail: { orderId: req.params.id } } });
  res.json({ ok: true });
}));

// ---------- reservations ----------
ops.get('/reservations', requireRole(...STAFF), requireFeature('reservations'), wrap(async (req, res) => {
  const q = parse(z.object({ from: z.string().datetime().optional() }), req.query);
  res.json(await prisma.reservation.findMany({
    where: { restaurantId: rid(req), startsAt: { gte: q.from ? new Date(q.from) : new Date(Date.now() - 86_400_000) } },
    include: { table: { select: { label: true } } }, orderBy: { startsAt: 'asc' }, take: 200,
  }));
}));

ops.patch('/reservations/:id', requireRole(...STAFF), requireFeature('reservations'), wrap(async (req, res) => {
  const { status } = parse(z.object({ status: z.enum(['CANCELLED', 'NO_SHOW', 'COMPLETED']) }), req.body);
  const r = await prisma.reservation.updateMany({ where: { id: req.params.id, restaurantId: rid(req), status: 'CONFIRMED' }, data: { status } });
  if (!r.count) throw new HttpError(409, 'Reservation is not active', 'bad_transition');
  res.json({ ok: true });
}));

// ---------- dashboard ----------
export function range(q: { range: string; from?: string; to?: string; tzOffset: number }) {
  const off = q.tzOffset * 60_000;
  const sod = (ms: number) => Math.floor((ms - off) / 86_400_000) * 86_400_000 + off; // start of local day
  const today = sod(Date.now());
  switch (q.range) {
    case 'yesterday': return { from: new Date(today - 86_400_000), to: new Date(today) };
    case '7d': return { from: new Date(today - 6 * 86_400_000), to: new Date(today + 86_400_000) };
    case '30d': return { from: new Date(today - 29 * 86_400_000), to: new Date(today + 86_400_000) };
    case 'custom': {
      if (!q.from || !q.to) throw new HttpError(400, 'from and to are required', 'validation');
      return { from: new Date(sod(Date.parse(q.from))), to: new Date(sod(Date.parse(q.to)) + 86_400_000) };
    }
    default: return { from: new Date(today), to: new Date(today + 86_400_000) };
  }
}

ops.get('/dashboard', requireRole(...MANAGE), wrap(async (req, res) => {
  const q = parse(z.object({
    range: z.enum(['today', 'yesterday', '7d', '30d', 'custom']).default('today'),
    from: z.string().optional(), to: z.string().optional(), tzOffset: z.coerce.number().int().min(-840).max(840).default(0),
  }), req.query);
  const { from, to } = range(q);
  const restaurantId = rid(req);
  const orders = await prisma.order.findMany({
    where: { restaurantId, createdAt: { gte: from, lt: to } },
    include: { items: { select: { name: true, quantity: true, unitPriceCents: true } } },
  });
  const valid = orders.filter((o) => o.status !== 'CANCELLED' && o.status !== 'PENDING_PAYMENT'); // unpaid online orders aren't sales yet
  const revenue = valid.reduce((s, o) => s + o.totalCents, 0);
  const pending = orders.filter((o) => ['NEW', 'ACCEPTED', 'PREPARING', 'READY'].includes(o.status)).length;

  const off = q.tzOffset * 60_000;
  const byDay = new Map<string, { revenueCents: number; orders: number }>();
  for (let t = from.getTime(); t < to.getTime(); t += 86_400_000) byDay.set(new Date(t - off).toISOString().slice(0, 10), { revenueCents: 0, orders: 0 });
  const byHour = Array.from({ length: 24 }, (_, h) => ({ hour: h, orders: 0 }));
  const prod = new Map<string, { quantity: number; revenueCents: number }>();
  for (const o of valid) {
    const day = byDay.get(new Date(o.createdAt.getTime() - off).toISOString().slice(0, 10));
    if (day) { day.revenueCents += o.totalCents; day.orders++; }
    byHour[new Date(o.createdAt.getTime() - off).getUTCHours()].orders++;
    for (const i of o.items) {
      const p = prod.get(i.name) ?? { quantity: 0, revenueCents: 0 };
      p.quantity += i.quantity; p.revenueCents += i.quantity * i.unitPriceCents; prod.set(i.name, p);
    }
  }
  const lowStock = (await prisma.$queryRaw<{ id: string; name: string; unit: string; stockQty: Prisma.Decimal; lowThreshold: Prisma.Decimal }[]>`
    SELECT id, name, unit, "stockQty", "lowThreshold" FROM "Ingredient"
    WHERE "restaurantId" = ${restaurantId} AND "stockQty" <= "lowThreshold" ORDER BY name LIMIT 10`)
    .map((i) => ({ id: i.id, name: i.name, unit: i.unit, stockQty: Number(i.stockQty), lowThreshold: Number(i.lowThreshold) }));
  const [reservations, activeCustomers, recent] = await Promise.all([
    prisma.reservation.count({ where: { restaurantId, startsAt: { gte: from, lt: to }, status: { not: 'CANCELLED' } } }),
    prisma.order.findMany({ where: { restaurantId, createdAt: { gte: from, lt: to }, customerId: { not: null } }, distinct: ['customerId'], select: { customerId: true } }),
    prisma.order.findMany({ where: { restaurantId }, orderBy: { createdAt: 'desc' }, take: 8, select: { number: true, status: true, customerName: true, totalCents: true, createdAt: true } }),
  ]);
  res.json({
    range: { from, to },
    revenueCents: revenue, orders: valid.length, pendingOrders: pending,
    completedOrders: orders.filter((o) => o.status === 'COMPLETED').length,
    cancelledOrders: orders.filter((o) => o.status === 'CANCELLED').length,
    averageOrderCents: valid.length ? Math.round(revenue / valid.length) : 0,
    reservations, activeCustomers: activeCustomers.length, lowStock,
    trend: [...byDay].map(([date, v]) => ({ date, ...v })),
    peakHours: byHour,
    topProducts: [...prod].map(([name, v]) => ({ name, ...v })).sort((a, b) => b.quantity - a.quantity).slice(0, 5),
    recent,
  });
}));

// ---------- super admin ----------
export const admin = Router();
admin.use(authenticate, requireRole('SUPER_ADMIN'));

admin.get('/restaurants', wrap(async (_req, res) => {
  const rs = await prisma.restaurant.findMany({
    include: { tenant: true, _count: { select: { orders: true, products: true } } }, orderBy: { createdAt: 'desc' },
  });
  res.json(rs.map((r) => ({
    id: r.id, name: r.name, slug: r.slug, published: r.published, tenantId: r.tenantId,
    status: r.tenant.status, plan: r.tenant.plan, maxOutlets: r.tenant.maxOutlets, orders: r._count.orders, products: r._count.products, createdAt: r.createdAt,
  })));
}));

admin.patch('/tenants/:id', wrap(async (req, res) => {
  const d = parse(z.object({ status: z.enum(['PENDING', 'ACTIVE', 'SUSPENDED']).optional(), plan: z.string().max(30).optional(), maxOutlets: z.number().int().min(1).max(500).optional() }), req.body);
  try {
    const t = await prisma.tenant.update({ where: { id: req.params.id }, data: d });
    clearAuthCache(); // a suspension must cut off sessions that are already open
    res.json(t);
  } catch { throw new HttpError(404, 'Not found', 'not_found'); }
}));

admin.get('/stats', wrap(async (_req, res) => {
  const [restaurants, orders, gmv] = await Promise.all([
    prisma.restaurant.count(), prisma.order.count({ where: { status: { not: 'CANCELLED' } } }),
    prisma.order.aggregate({ where: { status: { not: 'CANCELLED' } }, _sum: { totalCents: true } }),
  ]);
  res.json({ restaurants, orders, gmvCents: gmv._sum.totalCents ?? 0 });
}));
