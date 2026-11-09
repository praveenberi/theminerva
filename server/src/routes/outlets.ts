import { Router } from 'express';
import { z } from 'zod';
import { prisma, dec } from '../db.js';
import { attachAuth, requirePerm } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { badRequest, conflict, notFound, parse, slugify, wrap } from '../lib/http.js';

export const outletRouter = Router();
const guard = [attachAuth, requirePerm('settings.manage')];
const body = z.object({ name: z.string().trim().min(1).max(80), code: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{2,12}$/, 'Use 2–12 letters, numbers or -'), address: z.string().max(300).nullish(), phone: z.string().max(30).nullish(), isActive: z.boolean().default(true) });

// staff (any role) can list branches to pick/filter; assigned staff only get their own
outletRouter.get('/', attachAuth, requirePerm('orders.view'), wrap(async (req, res) => {
  const me = await prisma.user.findUnique({ where: { id: req.staff!.id }, select: { outletId: true } });
  res.json(await prisma.outlet.findMany({ where: me?.outletId ? { id: me.outletId } : {}, orderBy: { name: 'asc' }, include: { _count: { select: { tables: true, users: true, orders: true } } } }));
}));
outletRouter.post('/', ...guard, wrap(async (req, res) => {
  const b = parse(body, req.body);
  if (await prisma.outlet.findUnique({ where: { code: b.code } })) throw conflict('That branch code is already used');
  const o = await prisma.outlet.create({ data: b });
  await audit(req, 'outlet.create', 'Outlet', o.id);
  res.status(201).json(o);
}));
outletRouter.put('/:id', ...guard, wrap(async (req, res) => {
  const b = parse(body.partial(), req.body);
  const o = await prisma.outlet.update({ where: { id: req.params.id }, data: b }).catch(() => null);
  if (!o) throw notFound('Branch');
  await audit(req, 'outlet.update', 'Outlet', o.id);
  res.json(o);
}));
outletRouter.delete('/:id', ...guard, wrap(async (req, res) => {
  const used = await prisma.order.count({ where: { outletId: req.params.id } });
  if (used) { await prisma.outlet.update({ where: { id: req.params.id }, data: { isActive: false } }); return res.json({ ok: true, deactivated: true }); }
  await prisma.user.updateMany({ where: { outletId: req.params.id }, data: { outletId: null } });
  await prisma.diningTable.updateMany({ where: { outletId: req.params.id }, data: { outletId: null } });
  await prisma.outlet.delete({ where: { id: req.params.id } }).catch(() => { throw notFound('Branch'); });
  res.json({ ok: true });
}));

// branch-specific prices and availability
outletRouter.get('/:id/products', attachAuth, requirePerm('menu.manage'), wrap(async (req, res) => {
  const [products, overrides] = await Promise.all([
    prisma.product.findMany({ orderBy: [{ categoryId: 'asc' }, { sortOrder: 'asc' }], select: { id: true, name: true, price: true, category: { select: { name: true } } } }),
    prisma.outletProduct.findMany({ where: { outletId: req.params.id } }),
  ]);
  res.json(products.map((p) => { const o = overrides.find((x) => x.productId === p.id); return { ...p, branchPrice: o?.price ?? null, branchAvailable: o?.isAvailable ?? true }; }));
}));
outletRouter.put('/:id/products/:productId', attachAuth, requirePerm('menu.manage'), wrap(async (req, res) => {
  const b = parse(z.object({ price: z.number().min(0).max(100000).nullable(), isAvailable: z.boolean() }), req.body);
  const [o, p] = await Promise.all([prisma.outlet.findUnique({ where: { id: req.params.id } }), prisma.product.findUnique({ where: { id: req.params.productId } })]);
  if (!o || !p) throw notFound('Branch or dish');
  const key = { outletId_productId: { outletId: o.id, productId: p.id } };
  if (b.price === null && b.isAvailable) { await prisma.outletProduct.deleteMany({ where: { outletId: o.id, productId: p.id } }); return res.json({ ok: true, reset: true }); }
  const row = await prisma.outletProduct.upsert({ where: key, create: { outletId: o.id, productId: p.id, price: b.price === null ? null : dec(b.price), isAvailable: b.isAvailable }, update: { price: b.price === null ? null : dec(b.price), isAvailable: b.isAvailable } });
  await audit(req, 'outlet.price', 'OutletProduct', `${o.code}:${p.id}`, b);
  res.json(row);
}));

void badRequest; void slugify;
