import { Router } from 'express';
import QRCode from 'qrcode';
import PDFDocument from 'pdfkit';
import { z } from 'zod';
import { prisma } from '../db.js';
import { config } from '../config.js';
import { attachAuth, requirePerm } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { badRequest, conflict, notFound, parse, wrap } from '../lib/http.js';
import { broadcast } from '../lib/events.js';
import { staffAlert } from '../services/notify.js';
import { availability, book, cancel, reschedule } from '../services/reservations.js';
import { toCents, fromCents } from '../lib/money.js';

// ───────── tables / sessions / QR ─────────
export const tableRouter = Router();
const tableBody = z.object({ label: z.string().trim().min(1).max(20), capacity: z.number().int().min(1).max(50), zone: z.string().max(40).nullish(), posX: z.number().int().min(0).max(2000).default(0), posY: z.number().int().min(0).max(2000).default(0), isActive: z.boolean().default(true), outletId: z.string().nullish() });

tableRouter.get('/', attachAuth, requirePerm('orders.view', 'tables.manage'), wrap(async (_req, res) => {
  const tables = await prisma.diningTable.findMany({ orderBy: { label: 'asc' }, include: { sessions: { where: { closedAt: null }, include: { orders: { where: { status: { notIn: ['CANCELLED', 'REJECTED'] } }, select: { id: true, number: true, status: true, total: true } } } } } });
  res.json(tables.map((t) => ({ ...t, session: t.sessions[0] ?? null, sessions: undefined })));
}));
tableRouter.post('/', attachAuth, requirePerm('tables.manage'), wrap(async (req, res) => {
  if (req.staff!.role === 'WAITER') throw badRequest('Only managers can create tables');
  const b = parse(tableBody, req.body);
  if (await prisma.diningTable.findUnique({ where: { label: b.label } })) throw conflict(`Table "${b.label}" already exists`);
  const t = await prisma.diningTable.create({ data: b });
  await audit(req, 'table.create', 'DiningTable', t.id);
  res.status(201).json(t);
}));
tableRouter.put('/:id', attachAuth, requirePerm('tables.manage'), wrap(async (req, res) => {
  const b = parse(tableBody.partial().extend({ status: z.enum(['AVAILABLE', 'OCCUPIED', 'RESERVED', 'CLEANING']).optional() }), req.body);
  if (req.staff!.role === 'WAITER' && Object.keys(b).some((k) => k !== 'status')) throw badRequest('Waiters can only change table status');
  const t = await prisma.diningTable.update({ where: { id: req.params.id }, data: b }).catch(() => null);
  if (!t) throw notFound('Table');
  broadcast('staff', 'table.updated', { id: t.id });
  res.json(t);
}));
tableRouter.delete('/:id', attachAuth, requirePerm('tables.manage'), wrap(async (req, res) => {
  if (req.staff!.role === 'WAITER') throw badRequest('Only managers can delete tables');
  const used = await prisma.order.count({ where: { tableId: req.params.id } }) + await prisma.reservation.count({ where: { tableId: req.params.id } });
  if (used) { await prisma.diningTable.update({ where: { id: req.params.id }, data: { isActive: false } }); return res.json({ ok: true, archived: true }); }
  await prisma.diningTable.delete({ where: { id: req.params.id } }).catch(() => { throw notFound('Table'); });
  res.json({ ok: true });
}));

// customer actions from the QR page (the unguessable table token is the credential)
tableRouter.post('/by-token/:token/call-waiter', wrap(async (req, res) => {
  const t = await prisma.diningTable.findUnique({ where: { qrToken: req.params.token } });
  if (!t) throw notFound('Table');
  const s = await prisma.tableSession.findFirst({ where: { tableId: t.id, closedAt: null } });
  if (s) await prisma.tableSession.update({ where: { id: s.id }, data: { waiterCalledAt: new Date() } });
  await staffAlert('customer_request', `Table ${t.label} needs assistance`);
  res.json({ ok: true });
}));
tableRouter.post('/by-token/:token/request-bill', wrap(async (req, res) => {
  const t = await prisma.diningTable.findUnique({ where: { qrToken: req.params.token } });
  if (!t) throw notFound('Table');
  const s = await prisma.tableSession.findFirst({ where: { tableId: t.id, closedAt: null } });
  if (!s) throw badRequest('There is no open order at this table yet');
  await prisma.tableSession.update({ where: { id: s.id }, data: { billRequestedAt: new Date() } });
  await staffAlert('customer_request', `Table ${t.label} requested the bill`);
  res.json({ ok: true });
}));

/** Bill for a table session; optional equal split. */
tableRouter.get('/:id/bill', attachAuth, requirePerm('orders.view', 'payments.process'), wrap(async (req, res) => {
  const split = Math.max(1, Math.min(20, Number(req.query.split ?? 1) || 1));
  const s = await prisma.tableSession.findFirst({ where: { tableId: req.params.id, closedAt: null }, include: { orders: { where: { status: { notIn: ['CANCELLED', 'REJECTED'] } }, include: { items: true, payments: true } } } });
  if (!s) throw notFound('Open table session');
  const total = s.orders.reduce((a, o) => a + toCents(o.total), 0);
  const paid = s.orders.reduce((a, o) => a + o.payments.filter((p) => ['PAID', 'PARTIALLY_REFUNDED'].includes(p.status)).reduce((x, p) => x + toCents(p.amount), 0), 0);
  const due = total - paid;
  const base = Math.floor(due / split);
  const shares = Array.from({ length: split }, (_, i) => fromCents(base + (i === 0 ? due - base * split : 0)));
  res.json({ sessionId: s.id, orders: s.orders, total: fromCents(total), paid: fromCents(paid), due: fromCents(due), split, shares });
}));
tableRouter.post('/:id/close-session', attachAuth, requirePerm('tables.manage', 'payments.process'), wrap(async (req, res) => {
  const s = await prisma.tableSession.findFirst({ where: { tableId: req.params.id, closedAt: null }, include: { orders: { include: { payments: true } } } });
  if (!s) throw notFound('Open table session');
  const open = s.orders.filter((o) => !['COMPLETED', 'CANCELLED', 'REJECTED'].includes(o.status));
  if (open.length) throw conflict(`${open.length} order(s) are still open at this table`);
  const unpaid = s.orders.filter((o) => o.status === 'COMPLETED' && toCents(o.total) > o.payments.filter((p) => p.status === 'PAID' || p.status === 'PARTIALLY_REFUNDED').reduce((a, p) => a + toCents(p.amount), 0));
  if (unpaid.length && req.query.force !== 'true') throw conflict('The bill is not fully paid. Settle it first (or force-close as manager).');
  await prisma.$transaction([
    prisma.tableSession.update({ where: { id: s.id }, data: { closedAt: new Date() } }),
    prisma.diningTable.update({ where: { id: req.params.id }, data: { status: 'CLEANING' } }),
  ]);
  await audit(req, 'table.close_session', 'TableSession', s.id);
  broadcast('staff', 'table.updated', { id: req.params.id });
  res.json({ ok: true });
}));

export const qrRouter = Router();
async function qrTarget(type: string, id?: string) {
  const base = config.PUBLIC_WEB_URL.replace(/\/$/, '');
  switch (type) {
    case 'main': return { url: `${base}/`, label: 'The Minerva' };
    case 'takeaway': return { url: `${base}/order?type=takeaway`, label: 'Takeaway' };
    case 'event': return { url: `${base}/events`, label: 'Events' };
    case 'private-dining': return { url: `${base}/events?kind=private`, label: 'Private dining' };
    case 'table': {
      const t = id ? await prisma.diningTable.findUnique({ where: { id } }) : null;
      if (!t) throw notFound('Table');
      return { url: `${base}/t/${t.qrToken}`, label: `Table ${t.label}` };
    }
    default: throw badRequest('Unknown QR type');
  }
}
qrRouter.get('/:type.:format', attachAuth, requirePerm('tables.manage', 'settings.manage'), wrap(async (req, res) => {
  const { type, format } = req.params;
  const target = await qrTarget(type, typeof req.query.id === 'string' ? req.query.id : undefined);
  if (format === 'png') return res.type('png').attachment(`qr-${type}.png`).send(await QRCode.toBuffer(target.url, { width: 800, margin: 2 }));
  if (format === 'svg') return res.type('image/svg+xml').attachment(`qr-${type}.svg`).send(await QRCode.toString(target.url, { type: 'svg', margin: 2 }));
  if (format === 'pdf') {
    const r = await prisma.restaurant.findUnique({ where: { id: 'minerva' } });
    const png = await QRCode.toBuffer(target.url, { width: 600, margin: 1 });
    res.type('application/pdf').attachment(`qr-${type}.pdf`);
    const doc = new PDFDocument({ size: 'A5', margin: 40 });
    doc.pipe(res);
    doc.fontSize(26).text(r?.name ?? 'The Minerva', { align: 'center' }).moveDown(0.5);
    doc.fontSize(16).text(target.label, { align: 'center' }).moveDown();
    doc.image(png, (doc.page.width - 260) / 2, doc.y, { width: 260 });
    doc.moveDown(14).fontSize(12).text('Scan to view the menu and order', { align: 'center' });
    doc.end();
    return;
  }
  throw badRequest('Format must be png, svg or pdf');
}));

// ───────── reservations ─────────
export const reservationRouter = Router();

reservationRouter.get('/availability', wrap(async (req, res) => {
  const q = parse(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD'), guests: z.coerce.number().int().min(1) }), req.query);
  res.json(await availability(q.date, q.guests));
}));

reservationRouter.post('/', attachAuth, wrap(async (req, res) => {
  const b = parse(z.object({
    kind: z.enum(['TABLE', 'EVENT', 'PRIVATE_DINING']).default('TABLE'),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), time: z.string().regex(/^\d{2}:\d{2}$/), guests: z.number().int().min(1).max(500),
    name: z.string().trim().min(2).max(80), phone: z.string().trim().regex(/^\+?[0-9 ()-]{7,20}$/, 'Enter a valid phone number'), email: z.string().trim().email().optional(),
    notes: z.string().max(1000).optional(),
  }), req.body);
  const r = await book({ ...b, customerId: req.customer?.id });
  res.status(201).json({ id: r.id, reference: r.reference, status: r.status, startAt: r.startAt, guests: r.guests, kind: r.kind, depositAmount: r.depositAmount });
}));

reservationRouter.get('/', attachAuth, requirePerm('reservations.manage'), wrap(async (req, res) => {
  const q = parse(z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional(), status: z.string().optional() }), req.query);
  const where: any = {};
  if (q.from || q.to) where.startAt = { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) };
  if (q.status) where.status = { in: q.status.split(',') };
  res.json(await prisma.reservation.findMany({ where, orderBy: { startAt: 'asc' }, include: { table: true }, take: 500 }));
}));

reservationRouter.put('/:id', attachAuth, requirePerm('reservations.manage'), wrap(async (req, res) => {
  const b = parse(z.object({
    status: z.enum(['PENDING', 'CONFIRMED', 'SEATED', 'COMPLETED', 'CANCELLED', 'NO_SHOW']).optional(), tableId: z.string().nullish(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), time: z.string().regex(/^\d{2}:\d{2}$/).optional(), notes: z.string().max(1000).nullish(), depositPaid: z.boolean().optional(),
  }), req.body);
  let r = await prisma.reservation.findUnique({ where: { id: req.params.id } });
  if (!r) throw notFound('Reservation');
  if (b.date && b.time) r = await reschedule(r.id, b.date, b.time);
  if (b.status === 'CANCELLED') r = await cancel(r.id);
  else {
    const { date, time, status, ...rest } = b;
    r = await prisma.reservation.update({ where: { id: r.id }, data: { ...rest, ...(status ? { status } : {}) } });
    if (status === 'SEATED' && r.tableId) await prisma.diningTable.update({ where: { id: r.tableId }, data: { status: 'OCCUPIED' } });
  }
  await audit(req, 'reservation.update', 'Reservation', r.id, b);
  res.json(r);
}));

reservationRouter.delete('/:id', attachAuth, requirePerm('reservations.manage'), wrap(async (req, res) => {
  const r = await cancel(req.params.id);
  await audit(req, 'reservation.cancel', 'Reservation', r.id);
  res.json(r);
}));

// customer self-service via reference + phone (no account needed)
reservationRouter.post('/lookup/cancel', wrap(async (req, res) => {
  const b = parse(z.object({ reference: z.string(), phone: z.string() }), req.body);
  const r = await prisma.reservation.findUnique({ where: { reference: b.reference.toUpperCase() } });
  if (!r || r.phone.replace(/\D/g, '') !== b.phone.replace(/\D/g, '')) throw notFound('Reservation');
  res.json(await cancel(r.id));
}));

reservationRouter.get('/waitlist/all', attachAuth, requirePerm('reservations.manage'), wrap(async (_req, res) => {
  res.json(await prisma.waitlistEntry.findMany({ orderBy: { createdAt: 'asc' } }));
}));
reservationRouter.post('/waitlist', wrap(async (req, res) => {
  const b = parse(z.object({ name: z.string().trim().min(1).max(80), phone: z.string().trim().regex(/^\+?[0-9 ()-]{7,20}$/), guests: z.number().int().min(1).max(30) }), req.body);
  const w = await prisma.waitlistEntry.create({ data: b });
  void staffAlert('waitlist', `${b.name} (${b.guests}) joined the waitlist`);
  res.status(201).json(w);
}));
reservationRouter.delete('/waitlist/:id', attachAuth, requirePerm('reservations.manage'), wrap(async (req, res) => {
  await prisma.waitlistEntry.delete({ where: { id: req.params.id } }).catch(() => { throw notFound('Waitlist entry'); });
  res.json({ ok: true });
}));
