import { Router } from 'express';
import { z } from 'zod';
import { HttpError, parse, prisma } from '../lib/core';
import { MANAGE, STAFF, authenticate, requireRole, rid, wrap } from '../middleware/auth';

export const kitchen = Router();
const staff = [authenticate, requireRole(...STAFF)] as const;
const manage = [authenticate, requireRole(...MANAGE)] as const;

// ---------- kitchen display feed ----------
kitchen.get('/kds', ...staff, wrap(async (req, res) => {
  const orders = await prisma.order.findMany({
    where: { restaurantId: rid(req), status: { in: ['NEW', 'ACCEPTED', 'PREPARING', 'READY'] } },
    include: { items: { orderBy: { id: 'asc' }, include: { product: { select: { prepMinutes: true } } } }, table: { select: { label: true } } },
    orderBy: { createdAt: 'asc' }, take: 100,
  });
  res.json({
    now: new Date(),
    orders: orders.map((o) => ({
      id: o.id, number: o.number, type: o.type, status: o.status, table: o.table?.label ?? null, customerName: o.customerName,
      notes: o.notes, createdAt: o.createdAt,
      // the slowest dish sets the order's target time
      targetMinutes: Math.max(10, ...o.items.map((i) => i.product?.prepMinutes ?? 15)),
      items: o.items.map((i) => ({ id: i.id, name: i.name, quantity: i.quantity, options: i.options, notes: i.notes, done: i.prepDone })),
    })),
  });
}));

kitchen.patch('/orders/:id/items/:itemId', ...staff, wrap(async (req, res) => {
  const { done } = parse(z.object({ done: z.boolean() }), req.body);
  const r = await prisma.orderItem.updateMany({
    where: { id: req.params.itemId, orderId: req.params.id, order: { restaurantId: rid(req), status: { in: ['ACCEPTED', 'PREPARING'] } } },
    data: { prepDone: done },
  });
  if (!r.count) throw new HttpError(409, 'Item not found or the order is not being prepared', 'bad_transition');
  res.json({ ok: true });
}));

/** Kitchen performance: time from ACCEPTED to READY for orders finished in the window. */
kitchen.get('/kds/stats', ...staff, wrap(async (req, res) => {
  const q = parse(z.object({ tzOffset: z.coerce.number().int().min(-840).max(840).default(0) }), req.query);
  const off = q.tzOffset * 60_000;
  const since = new Date(Math.floor((Date.now() - off) / 86_400_000) * 86_400_000 + off); // start of local day
  const ready = await prisma.orderStatusHistory.findMany({
    where: { status: 'READY', createdAt: { gte: since }, order: { restaurantId: rid(req) } },
    select: { orderId: true, createdAt: true },
  });
  const accepted = await prisma.orderStatusHistory.findMany({
    where: { status: 'ACCEPTED', orderId: { in: ready.map((r) => r.orderId) } }, select: { orderId: true, createdAt: true },
  });
  const acc = new Map(accepted.map((a) => [a.orderId, a.createdAt.getTime()]));
  const mins = ready.filter((r) => acc.has(r.orderId)).map((r) => (r.createdAt.getTime() - acc.get(r.orderId)!) / 60_000);
  mins.sort((a, b) => a - b);
  res.json({
    readyToday: ready.length,
    avgPrepMinutes: mins.length ? Math.round((mins.reduce((s, m) => s + m, 0) / mins.length) * 10) / 10 : null,
    slowestPrepMinutes: mins.length ? Math.round(mins[mins.length - 1] * 10) / 10 : null,
  });
}));

// ---------- delivery: zones, partners, assignment ----------
const zoneSchema = z.object({
  name: z.string().trim().min(1).max(60),
  feeCents: z.number().int().min(0).max(10_000_000),
  minOrderCents: z.number().int().min(0).max(10_000_000).default(0),
  etaMinutes: z.number().int().min(5).max(240).default(45),
  active: z.boolean().default(true),
});
const dup = (e: any, what: string) => { if (e.code === 'P2002') throw new HttpError(409, `${what} with that name exists`, 'duplicate'); throw e; };

kitchen.get('/delivery/zones', ...manage, wrap(async (req, res) => {
  res.json(await prisma.deliveryZone.findMany({ where: { restaurantId: rid(req) }, orderBy: { feeCents: 'asc' } }));
}));
kitchen.post('/delivery/zones', ...manage, wrap(async (req, res) => {
  const d = parse(zoneSchema, req.body);
  try { res.status(201).json(await prisma.deliveryZone.create({ data: { ...d, restaurantId: rid(req) } })); } catch (e) { dup(e, 'A zone'); }
}));
kitchen.patch('/delivery/zones/:id', ...manage, wrap(async (req, res) => {
  const d = parse(zoneSchema.partial(), req.body);
  const r = await prisma.deliveryZone.updateMany({ where: { id: req.params.id, restaurantId: rid(req) }, data: d });
  if (!r.count) throw new HttpError(404, 'Not found', 'not_found');
  res.json({ ok: true });
}));
kitchen.delete('/delivery/zones/:id', ...manage, wrap(async (req, res) => {
  await prisma.deliveryZone.deleteMany({ where: { id: req.params.id, restaurantId: rid(req) } });
  res.status(204).end();
}));

const partnerSchema = z.object({ name: z.string().trim().min(1).max(60), phone: z.string().trim().regex(/^[+\d][\d\s-]{6,18}$/, 'Enter a valid phone number') });
kitchen.get('/delivery/partners', authenticate, requireRole(...MANAGE, 'WAITER'), wrap(async (req, res) => {
  res.json(await prisma.deliveryPartner.findMany({ where: { restaurantId: rid(req) }, orderBy: { name: 'asc' } }));
}));
kitchen.post('/delivery/partners', ...manage, wrap(async (req, res) => {
  const d = parse(partnerSchema, req.body);
  try { res.status(201).json(await prisma.deliveryPartner.create({ data: { ...d, restaurantId: rid(req) } })); } catch (e) { dup(e, 'A partner'); }
}));
kitchen.patch('/delivery/partners/:id', ...manage, wrap(async (req, res) => {
  const d = parse(z.object({ active: z.boolean() }), req.body);
  const r = await prisma.deliveryPartner.updateMany({ where: { id: req.params.id, restaurantId: rid(req) }, data: d });
  if (!r.count) throw new HttpError(404, 'Not found', 'not_found');
  res.json({ ok: true });
}));
kitchen.delete('/delivery/partners/:id', ...manage, wrap(async (req, res) => {
  await prisma.deliveryPartner.deleteMany({ where: { id: req.params.id, restaurantId: rid(req) } });
  res.status(204).end();
}));

kitchen.patch('/orders/:id/delivery', authenticate, requireRole(...MANAGE, 'WAITER'), wrap(async (req, res) => {
  const { partnerId } = parse(z.object({ partnerId: z.string().nullable() }), req.body);
  const restaurantId = rid(req);
  if (partnerId && !(await prisma.deliveryPartner.count({ where: { id: partnerId, restaurantId, active: true } })))
    throw new HttpError(400, 'Unknown or inactive delivery partner', 'validation', { partnerId: ['Unknown partner'] });
  const r = await prisma.order.updateMany({
    where: { id: req.params.id, restaurantId, type: 'DELIVERY', status: { in: ['NEW', 'ACCEPTED', 'PREPARING', 'READY'] } },
    data: { deliveryPartnerId: partnerId },
  });
  if (!r.count) throw new HttpError(409, 'Not an open delivery order', 'bad_transition');
  res.json({ ok: true });
}));
