import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { attachAuth, hashPassword, requirePerm } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { ApiError, badRequest, conflict, forbidden, notFound, parse, wrap } from '../lib/http.js';

export const staffRouter = Router();
const guard = [attachAuth, requirePerm('staff.manage')];
const pw = z.string().min(10).regex(/[a-z]/, 'Include a lowercase letter').regex(/[A-Z]/, 'Include an uppercase letter').regex(/\d/, 'Include a number');
const sel = { id: true, email: true, name: true, phone: true, role: true, isActive: true, outletId: true, lastLoginAt: true, createdAt: true } as const;

staffRouter.get('/', ...guard, wrap(async (_req, res) => { res.json(await prisma.user.findMany({ select: sel, orderBy: { createdAt: 'asc' } })); }));
// drivers list is needed by order assignment (managers / cashiers)
staffRouter.get('/drivers', attachAuth, requirePerm('orders.manage'), wrap(async (_req, res) => {
  res.json(await prisma.user.findMany({ where: { role: 'DELIVERY', isActive: true }, select: { id: true, name: true } }));
}));

staffRouter.post('/', ...guard, wrap(async (req, res) => {
  const b = parse(z.object({ email: z.string().trim().toLowerCase().email(), name: z.string().trim().min(2).max(80), phone: z.string().max(30).optional(), role: z.enum(['OWNER', 'MANAGER', 'KITCHEN', 'WAITER', 'CASHIER', 'DELIVERY']), password: pw, outletId: z.string().optional() }), req.body);
  if (b.role === 'OWNER' && req.staff!.role !== 'OWNER') throw forbidden('Only an owner can create another owner');
  if (await prisma.user.findUnique({ where: { email: b.email } })) throw conflict('A staff member with this email already exists');
  const { password, ...rest } = b;
  const u = await prisma.user.create({ data: { ...rest, passwordHash: await hashPassword(password) }, select: sel });
  await audit(req, 'staff.create', 'User', u.id, { role: u.role });
  res.status(201).json(u);
}));
staffRouter.put('/:id', ...guard, wrap(async (req, res) => {
  const b = parse(z.object({ name: z.string().trim().min(2).max(80), phone: z.string().max(30).nullish(), role: z.enum(['OWNER', 'MANAGER', 'KITCHEN', 'WAITER', 'CASHIER', 'DELIVERY']), isActive: z.boolean(), outletId: z.string().nullish(), password: pw }).partial(), req.body);
  const target = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!target) throw notFound('Staff member');
  if ((target.role === 'OWNER' || b.role === 'OWNER') && req.staff!.role !== 'OWNER') throw forbidden('Only an owner can change owner accounts');
  if (target.id === req.staff!.id && (b.isActive === false || (b.role && b.role !== target.role))) throw badRequest('You cannot deactivate or demote your own account');
  if (target.role === 'OWNER' && (b.isActive === false || (b.role && b.role !== 'OWNER'))) {
    const owners = await prisma.user.count({ where: { role: 'OWNER', isActive: true } });
    if (owners <= 1) throw badRequest('At least one active owner is required');
  }
  const { password, ...rest } = b;
  const u = await prisma.user.update({ where: { id: target.id }, data: { ...rest, ...(password ? { passwordHash: await hashPassword(password) } : {}) }, select: sel });
  if (b.isActive === false || password || b.role) await prisma.refreshToken.updateMany({ where: { userId: u.id, revokedAt: null }, data: { revokedAt: new Date() } });
  await audit(req, 'staff.update', 'User', u.id, { fields: Object.keys(b).filter((k) => k !== 'password') });
  res.json(u);
}));

// shifts, attendance, tasks
staffRouter.get('/shifts', attachAuth, requirePerm('staff.manage', 'orders.view'), wrap(async (req, res) => {
  const q = parse(z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional() }), req.query);
  const where: any = {};
  if (q.from || q.to) where.startAt = { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) };
  if (!['OWNER', 'MANAGER'].includes(req.staff!.role)) where.userId = req.staff!.id;
  res.json(await prisma.shift.findMany({ where, orderBy: { startAt: 'asc' }, include: { user: { select: { name: true, role: true } } } }));
}));
staffRouter.post('/shifts', ...guard, wrap(async (req, res) => {
  const b = parse(z.object({ userId: z.string(), startAt: z.coerce.date(), endAt: z.coerce.date(), notes: z.string().max(200).optional() }).refine((x) => x.endAt > x.startAt, { message: 'End must be after start', path: ['endAt'] }), req.body);
  const overlap = await prisma.shift.count({ where: { userId: b.userId, startAt: { lt: b.endAt }, endAt: { gt: b.startAt } } });
  if (overlap) throw conflict('This person already has an overlapping shift');
  res.status(201).json(await prisma.shift.create({ data: b }));
}));
staffRouter.delete('/shifts/:id', ...guard, wrap(async (req, res) => { await prisma.shift.delete({ where: { id: req.params.id } }).catch(() => { throw notFound('Shift'); }); res.json({ ok: true }); }));

staffRouter.post('/attendance/clock', attachAuth, wrap(async (req, res) => {
  if (!req.staff) throw new ApiError(401, 'UNAUTHORIZED', 'Authentication required');
  const open = await prisma.attendance.findFirst({ where: { userId: req.staff.id, clockOut: null } });
  if (open) return res.json(await prisma.attendance.update({ where: { id: open.id }, data: { clockOut: new Date() } }));
  res.status(201).json(await prisma.attendance.create({ data: { userId: req.staff.id } }));
}));
staffRouter.get('/attendance', ...guard, wrap(async (_req, res) => {
  res.json(await prisma.attendance.findMany({ orderBy: { clockIn: 'desc' }, take: 200, include: { user: { select: { name: true } } } }));
}));
staffRouter.get('/tasks', attachAuth, requirePerm('orders.view'), wrap(async (req, res) => {
  const where = ['OWNER', 'MANAGER'].includes(req.staff!.role) ? {} : { assigneeId: req.staff!.id };
  res.json(await prisma.staffTask.findMany({ where, orderBy: { createdAt: 'desc' }, take: 100, include: { assignee: { select: { name: true } } } }));
}));
staffRouter.post('/tasks', ...guard, wrap(async (req, res) => {
  const b = parse(z.object({ assigneeId: z.string(), title: z.string().trim().min(1).max(200), dueAt: z.coerce.date().optional() }), req.body);
  res.status(201).json(await prisma.staffTask.create({ data: b }));
}));
staffRouter.post('/tasks/:id/done', attachAuth, requirePerm('orders.view'), wrap(async (req, res) => {
  const t = await prisma.staffTask.findUnique({ where: { id: req.params.id } });
  if (!t || (t.assigneeId !== req.staff!.id && !['OWNER', 'MANAGER'].includes(req.staff!.role))) throw notFound('Task');
  res.json(await prisma.staffTask.update({ where: { id: t.id }, data: { doneAt: new Date() } }));
}));

staffRouter.get('/performance', ...guard, wrap(async (req, res) => {
  const q = parse(z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional() }), req.query);
  const from = q.from ?? new Date(Date.now() - 30 * 864e5), to = q.to ?? new Date();
  const rows = await prisma.orderStatusHistory.groupBy({ by: ['byUserId', 'status'], where: { byUserId: { not: null }, createdAt: { gte: from, lte: to } }, _count: true });
  const users = await prisma.user.findMany({ select: { id: true, name: true, role: true } });
  res.json(users.map((u) => ({ ...u, handled: rows.filter((r) => r.byUserId === u.id).reduce((a, r) => a + r._count, 0), completed: rows.find((r) => r.byUserId === u.id && r.status === 'COMPLETED')?._count ?? 0 })).filter((u) => u.handled));
}));
