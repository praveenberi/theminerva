import { Router } from 'express';
import PDFDocument from 'pdfkit';
import { z } from 'zod';
import { prisma, dec } from '../db.js';
import { attachAuth, requirePerm } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { badRequest, conflict, forbidden, notFound, pageQuery, paged, paginate, parse, wrap } from '../lib/http.js';
import { can } from '../lib/permissions.js';
import { broadcast } from '../lib/events.js';
import { createOrder, changeStatus, notifyCustomers, orderInclude, setItemStatus } from '../services/orders.js';
import { priceCart } from '../services/pricing.js';
import { toCents, fromCents } from '../lib/money.js';

export const orderRouter = Router();

/** Staff assigned to a branch only see that branch; unassigned staff (owner/head office) see all. */
export async function staffOutlet(userId: string) {
  return (await prisma.user.findUnique({ where: { id: userId }, select: { outletId: true } }))?.outletId ?? null;
}

/** Kitchen staff need what to cook, not who the customer is or what they paid. */
function redact<T extends Record<string, any>>(role: string, o: T): T {
  if (role !== 'KITCHEN') return o;
  const { guestPhone, guestEmail, deliveryAddress, deliveryPostal, deliveryNotes, payments, customer, ...rest } = o;
  return { ...rest, customer: customer ? { name: customer.name } : null, payments: [] } as unknown as T;
}

const itemSchema = z.object({ productId: z.string(), variantId: z.string().optional(), addonIds: z.array(z.string()).optional(), quantity: z.number().int().min(1).max(50), notes: z.string().max(300).optional() });
const createSchema = z.object({
  items: z.array(itemSchema).min(1).max(60),
  type: z.enum(['DINE_IN', 'TAKEAWAY', 'PICKUP', 'DELIVERY']),
  guest: z.object({ name: z.string().trim().min(1).max(80).optional(), phone: z.string().trim().regex(/^\+?[0-9 ()-]{7,20}$/, 'Enter a valid phone number').optional(), email: z.string().trim().email().optional() }).optional(),
  tableToken: z.string().optional(), tableLabel: z.string().max(20).optional(), tableId: z.string().optional(), outletId: z.string().optional(),
  deliveryAddress: z.string().trim().max(300).optional(), deliveryPostal: z.string().max(12).optional(), deliveryNotes: z.string().max(300).optional(),
  scheduledFor: z.coerce.date().optional(), notes: z.string().max(500).optional(),
  couponCode: z.string().max(40).optional(), voucherCode: z.string().max(40).optional(), redeemPoints: z.number().int().min(0).optional(), tip: z.number().min(0).max(1000).optional(),
});

orderRouter.post('/', attachAuth, wrap(async (req, res) => {
  const b = parse(createSchema, req.body);
  const staff = req.staff && can(req.staff.role, 'orders.create') ? req.staff : undefined;
  if ((b.tableId) && !staff) throw forbidden();
  if (!req.customer && !b.guest?.name && !staff && !b.tableToken && !b.tableLabel) throw badRequest('Please enter your name');
  const key = typeof req.headers['idempotency-key'] === 'string' ? req.headers['idempotency-key'].slice(0, 100) : undefined;
  const order = await createOrder({
    ...b, customerId: req.customer?.id, createdByStaff: !!staff, idempotencyKey: key,
  });
  if (staff) await audit(req, 'order.create_staff', 'Order', order.id);
  res.status(201).json({ id: order.id, number: order.number, trackingToken: order.trackingToken, status: order.status, total: order.total, subtotal: order.subtotal, discount: order.discount, tax: order.tax, serviceCharge: order.serviceCharge, deliveryFee: order.deliveryFee, tip: order.tip });
}));

orderRouter.post('/quote', attachAuth, wrap(async (req, res) => {
  const b = parse(createSchema.pick({ items: true, type: true, outletId: true, couponCode: true, voucherCode: true, redeemPoints: true, tip: true, deliveryPostal: true }), req.body);
  res.json(await priceCart({ ...b, customerId: req.customer?.id }));
}));

orderRouter.get('/', attachAuth, requirePerm('orders.view'), wrap(async (req, res) => {
  const q = parse(pageQuery.extend({
    status: z.string().optional(), type: z.string().optional(), outletId: z.string().optional(), from: z.coerce.date().optional(), to: z.coerce.date().optional(), active: z.enum(['true', 'false']).optional(),
  }), req.query);
  const where: any = {};
  if (q.status) where.status = { in: q.status.split(',') };
  if (q.type) where.type = q.type;
  if (q.active === 'true') where.status = { notIn: ['COMPLETED', 'CANCELLED', 'REJECTED'] };
  if (q.from || q.to) where.createdAt = { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) };
  if (q.q) {
    const n = Number(q.q.replace('#', ''));
    where.OR = [
      ...(Number.isInteger(n) ? [{ number: n }] : []),
      { guestName: { contains: q.q, mode: 'insensitive' } }, { guestPhone: { contains: q.q } }, { customer: { name: { contains: q.q, mode: 'insensitive' } } },
    ];
  }
  if (req.staff!.role === 'DELIVERY') where.driverId = req.staff!.id;
  const own = await staffOutlet(req.staff!.id);
  if (own) where.outletId = own; else if (q.outletId) where.outletId = q.outletId;
  const [items, total] = await Promise.all([
    prisma.order.findMany({ where, ...paginate(q), orderBy: { createdAt: q.dir }, include: orderInclude }),
    prisma.order.count({ where }),
  ]);
  res.json(paged(items.map((i) => redact(req.staff!.role, i)), total, q));
}));

orderRouter.get('/board', attachAuth, requirePerm('orders.view'), wrap(async (req, res) => {
  const where: any = { status: { notIn: ['COMPLETED', 'CANCELLED', 'REJECTED'] } };
  if (req.staff!.role === 'DELIVERY') where.driverId = req.staff!.id;
  const own = await staffOutlet(req.staff!.id);
  const oid = own ?? (typeof req.query.outletId === 'string' ? req.query.outletId : undefined);
  if (oid) where.outletId = oid;
  const items = await prisma.order.findMany({ where, orderBy: { createdAt: 'asc' }, include: orderInclude, take: 200 });
  // kitchen staff must not see customer contact or payment details
  const safe = req.staff!.role === 'KITCHEN'
    ? items.map(({ customer, guestPhone, guestEmail, payments, deliveryAddress, ...o }) => ({ ...o, customer: customer && { name: customer.name } }))
    : items;
  res.json({ items: safe, serverTime: new Date().toISOString() });
}));

orderRouter.get('/:id', attachAuth, requirePerm('orders.view'), wrap(async (req, res) => {
  const o = await prisma.order.findUnique({ where: { id: req.params.id }, include: orderInclude });
  if (!o) throw notFound('Order');
  if (req.staff!.role === 'DELIVERY' && o.driverId !== req.staff!.id) throw forbidden();
  res.json(redact(req.staff!.role, o));
}));

orderRouter.patch('/:id/status', attachAuth, requirePerm('orders.view'), wrap(async (req, res) => {
  const b = parse(z.object({ status: z.enum(['ACCEPTED', 'PREPARING', 'READY', 'OUT_FOR_DELIVERY', 'SERVED', 'COMPLETED', 'REJECTED', 'CANCELLED']), note: z.string().max(300).optional() }), req.body);
  if (['REJECTED', 'CANCELLED'].includes(b.status) && !can(req.staff!.role, 'orders.manage') && !can(req.staff!.role, 'kitchen.manage')) throw forbidden();
  const o = await changeStatus(req.params.id, b.status, req.staff!, b.note);
  await audit(req, 'order.status', 'Order', o.id, { to: b.status });
  res.json(o);
}));

orderRouter.patch('/:id', attachAuth, requirePerm('orders.manage', 'kitchen.manage'), wrap(async (req, res) => {
  const b = parse(z.object({ kitchenNotes: z.string().max(500).nullish(), prepMinutes: z.number().int().min(1).max(240).optional(), assignedToId: z.string().nullish(), driverId: z.string().nullish() }), req.body);
  if (!can(req.staff!.role, 'orders.manage') && (b.assignedToId !== undefined || b.driverId !== undefined)) throw forbidden();
  if (b.driverId) {
    const d = await prisma.user.findUnique({ where: { id: b.driverId } });
    if (!d || d.role !== 'DELIVERY' || !d.isActive) throw badRequest('Choose an active delivery staff member');
  }
  const o = await prisma.order.update({ where: { id: req.params.id }, data: b, include: orderInclude }).catch(() => null);
  if (!o) throw notFound('Order');
  broadcast('staff', 'order.updated', { id: o.id });
  void notifyCustomers(o, 'order.updated', { status: o.status });
  res.json(o);
}));

orderRouter.patch('/:id/items/:itemId', attachAuth, requirePerm('kitchen.manage', 'orders.manage'), wrap(async (req, res) => {
  const { status } = parse(z.object({ status: z.enum(['PENDING', 'PREPARING', 'READY']) }), req.body);
  await setItemStatus(req.params.id, req.params.itemId, status);
  res.json({ ok: true });
}));

/** Waiter adds more dishes to a running table order. Totals are re-priced on the server. */
orderRouter.post('/:id/items', attachAuth, requirePerm('orders.create'), wrap(async (req, res) => {
  const { items } = parse(z.object({ items: z.array(itemSchema).min(1).max(30) }), req.body);
  const o = await prisma.order.findUnique({ where: { id: req.params.id } });
  if (!o) throw notFound('Order');
  if (o.type !== 'DINE_IN' || !['NEW', 'ACCEPTED', 'PREPARING'].includes(o.status)) throw conflict('Items can only be added to a running dine-in order. Create a new order for this table instead.');
  const p = await priceCart({ items, type: 'DINE_IN', customerId: o.customerId });
  const updated = await prisma.$transaction(async (tx) => {
    await tx.orderItem.createMany({
      data: p.lines.map((l) => ({ orderId: o.id, productId: l.productId, name: l.name, variantName: l.variantName, addons: l.addons as any, quantity: l.quantity, unitPrice: dec(l.unitPrice), lineTotal: dec(l.lineTotal), notes: l.notes })),
    });
    return tx.order.update({
      where: { id: o.id },
      data: {
        subtotal: dec(fromCents(toCents(o.subtotal) + toCents(p.subtotal))), serviceCharge: dec(fromCents(toCents(o.serviceCharge) + toCents(p.serviceCharge))),
        tax: dec(fromCents(toCents(o.tax) + toCents(p.tax))), total: dec(fromCents(toCents(o.total) + toCents(p.total))),
      },
      include: orderInclude,
    });
  });
  broadcast('staff', 'order.updated', { id: o.id, itemsAdded: true });
  await audit(req, 'order.add_items', 'Order', o.id);
  res.json(updated);
}));

orderRouter.get('/:id/receipt.pdf', attachAuth, requirePerm('orders.view', 'payments.process'), wrap(async (req, res) => {
  const o = await prisma.order.findUnique({ where: { id: req.params.id }, include: { items: true, payments: true } });
  if (!o) throw notFound('Order');
  const r = await prisma.restaurant.findUnique({ where: { id: 'minerva' } });
  const cur = r?.currency ?? 'SGD';
  const money = (v: unknown) => `${cur} ${Number(v).toFixed(2)}`;
  res.type('application/pdf').setHeader('Content-Disposition', `inline; filename="receipt-${o.number}.pdf"`);
  const doc = new PDFDocument({ size: [226, 600], margin: 14 });
  doc.pipe(res);
  doc.fontSize(14).text(r?.name ?? 'The Minerva', { align: 'center' });
  doc.fontSize(8).text([r?.address, r?.phone].filter(Boolean).join('\n'), { align: 'center' }).moveDown(0.5);
  doc.fontSize(9).text(`Order #${o.number} · ${o.type.replace('_', ' ')}`).text(o.createdAt.toLocaleString('en-GB', { timeZone: r?.timezone })).moveDown(0.5);
  for (const i of o.items) doc.text(`${i.quantity} × ${i.name}${i.variantName ? ` (${i.variantName})` : ''}`).text(money(i.lineTotal), { align: 'right' });
  doc.moveDown(0.5);
  const row = (k: string, v: unknown) => { doc.text(k, { continued: true }).text(money(v), { align: 'right' }); };
  row('Subtotal', o.subtotal);
  if (Number(o.discount)) row('Discount', -Number(o.discount));
  if (Number(o.serviceCharge)) row('Service charge', o.serviceCharge);
  if (Number(o.tax)) row('Tax', o.tax);
  if (Number(o.deliveryFee)) row('Delivery', o.deliveryFee);
  if (Number(o.tip)) row('Tip', o.tip);
  doc.fontSize(11).font('Helvetica-Bold'); row('Total', o.total);
  doc.font('Helvetica').fontSize(8).moveDown().text(`Paid: ${money(o.payments.filter((p) => p.status === 'PAID' || p.status === 'PARTIALLY_REFUNDED').reduce((a, p) => a + Number(p.amount), 0))}`, { align: 'center' }).text('Thank you!', { align: 'center' });
  doc.end();
}));
