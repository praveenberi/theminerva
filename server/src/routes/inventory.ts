import { Router } from 'express';
import { z } from 'zod';
import { prisma, dec } from '../db.js';
import { attachAuth, requirePerm } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { badRequest, conflict, notFound, pageQuery, paged, paginate, parse, wrap } from '../lib/http.js';
import { checkLowStock } from '../services/inventory.js';

export const inventoryRouter = Router();
const guard = [attachAuth, requirePerm('inventory.manage')];

const ingBody = z.object({ name: z.string().trim().min(1).max(80), unit: z.string().trim().min(1).max(12), stock: z.number().min(0).default(0), reorderLevel: z.number().min(0).default(0), costPerUnit: z.number().min(0).default(0), expiresOn: z.coerce.date().nullish(), supplierId: z.string().nullish() });

inventoryRouter.get('/', ...guard, wrap(async (req, res) => {
  const q = parse(pageQuery.extend({ low: z.enum(['true']).optional() }), req.query);
  const where: any = q.q ? { name: { contains: q.q, mode: 'insensitive' } } : {};
  const all = await prisma.ingredient.findMany({ where, orderBy: { name: 'asc' }, include: { supplier: { select: { id: true, name: true } } } });
  const soon = Date.now() + 7 * 864e5;
  const rows = all.map((i) => ({ ...i, isLow: Number(i.reorderLevel) > 0 && Number(i.stock) <= Number(i.reorderLevel), expiringSoon: !!i.expiresOn && i.expiresOn.getTime() < soon }));
  const filtered = q.low ? rows.filter((r) => r.isLow) : rows;
  const page = filtered.slice((q.page - 1) * q.pageSize, q.page * q.pageSize);
  res.json({ ...paged(page, filtered.length, q), lowCount: rows.filter((r) => r.isLow).length });
}));
inventoryRouter.post('/', ...guard, wrap(async (req, res) => {
  const b = parse(ingBody, req.body);
  if (await prisma.ingredient.findUnique({ where: { name: b.name } })) throw conflict(`"${b.name}" already exists`);
  const i = await prisma.ingredient.create({ data: { ...b, stock: dec(b.stock), reorderLevel: dec(b.reorderLevel), costPerUnit: dec(b.costPerUnit) } });
  if (b.stock) await prisma.stockMovement.create({ data: { ingredientId: i.id, type: 'RECEIPT', quantity: dec(b.stock), note: 'Opening stock' } });
  await audit(req, 'inventory.create', 'Ingredient', i.id);
  res.status(201).json(i);
}));
inventoryRouter.put('/:id', ...guard, wrap(async (req, res) => {
  const { stock, ...b } = parse(ingBody.partial(), req.body); // stock only changes via movements
  void stock;
  const i = await prisma.ingredient.update({ where: { id: req.params.id }, data: { ...b, reorderLevel: b.reorderLevel === undefined ? undefined : dec(b.reorderLevel), costPerUnit: b.costPerUnit === undefined ? undefined : dec(b.costPerUnit) } }).catch(() => null);
  if (!i) throw notFound('Ingredient');
  await audit(req, 'inventory.update', 'Ingredient', i.id);
  res.json(i);
}));
inventoryRouter.delete('/:id', ...guard, wrap(async (req, res) => {
  const used = await prisma.recipeLine.count({ where: { ingredientId: req.params.id } });
  if (used) throw badRequest('This ingredient is used in recipes. Remove it from them first.');
  await prisma.ingredient.delete({ where: { id: req.params.id } }).catch(() => { throw notFound('Ingredient'); });
  res.json({ ok: true });
}));

/** receipt / adjustment / wastage / reconciliation — every stock change leaves a ledger row. */
inventoryRouter.post('/:id/move', ...guard, wrap(async (req, res) => {
  const b = parse(z.object({ type: z.enum(['RECEIPT', 'ADJUSTMENT', 'WASTAGE', 'RECONCILIATION']), quantity: z.number(), note: z.string().max(200).optional() }), req.body);
  const out = await prisma.$transaction(async (tx) => {
    const cur = await tx.ingredient.findUnique({ where: { id: req.params.id } });
    if (!cur) throw notFound('Ingredient');
    let delta = b.quantity;
    if (b.type === 'WASTAGE') delta = -Math.abs(b.quantity);
    if (b.type === 'RECEIPT') delta = Math.abs(b.quantity);
    if (b.type === 'RECONCILIATION') { if (b.quantity < 0) throw badRequest('Counted quantity cannot be negative'); delta = b.quantity - Number(cur.stock); }
    if (Number(cur.stock) + delta < 0) throw badRequest('Stock cannot go below zero');
    await tx.ingredient.update({ where: { id: cur.id }, data: { stock: { increment: dec(delta) } } });
    return tx.stockMovement.create({ data: { ingredientId: cur.id, type: b.type, quantity: dec(delta), note: b.note, reference: req.staff!.id } });
  });
  await audit(req, 'inventory.move', 'Ingredient', req.params.id, b);
  void checkLowStock([req.params.id]);
  res.status(201).json(out);
}));
inventoryRouter.get('/:id/history', ...guard, wrap(async (req, res) => {
  res.json(await prisma.stockMovement.findMany({ where: { ingredientId: req.params.id }, orderBy: { createdAt: 'desc' }, take: 200 }));
}));

// suppliers
inventoryRouter.get('/suppliers/all', ...guard, wrap(async (_req, res) => { res.json(await prisma.supplier.findMany({ orderBy: { name: 'asc' } })); }));
const supBody = z.object({ name: z.string().trim().min(1).max(100), contact: z.string().max(100).nullish(), phone: z.string().max(30).nullish(), email: z.string().email().nullish().or(z.literal('')) });
inventoryRouter.post('/suppliers', ...guard, wrap(async (req, res) => { const b = parse(supBody, req.body); res.status(201).json(await prisma.supplier.create({ data: { ...b, email: b.email || null } })); }));
inventoryRouter.put('/suppliers/:id', ...guard, wrap(async (req, res) => { const b = parse(supBody.partial(), req.body); res.json(await prisma.supplier.update({ where: { id: req.params.id }, data: { ...b, email: b.email || null } }).catch(() => { throw notFound('Supplier'); })); }));
inventoryRouter.delete('/suppliers/:id', ...guard, wrap(async (req, res) => {
  const n = await prisma.purchaseOrder.count({ where: { supplierId: req.params.id } });
  if (n) throw badRequest('This supplier has purchase orders and cannot be deleted');
  await prisma.ingredient.updateMany({ where: { supplierId: req.params.id }, data: { supplierId: null } });
  await prisma.supplier.delete({ where: { id: req.params.id } }).catch(() => { throw notFound('Supplier'); });
  res.json({ ok: true });
}));

// purchase orders
inventoryRouter.get('/purchase-orders/all', ...guard, wrap(async (_req, res) => {
  res.json(await prisma.purchaseOrder.findMany({ orderBy: { createdAt: 'desc' }, take: 100, include: { supplier: true, lines: { include: { ingredient: true } } } }));
}));
inventoryRouter.post('/purchase-orders', ...guard, wrap(async (req, res) => {
  const b = parse(z.object({ supplierId: z.string(), lines: z.array(z.object({ ingredientId: z.string(), quantity: z.number().positive(), unitCost: z.number().min(0) })).min(1) }), req.body);
  const po = await prisma.purchaseOrder.create({ data: { supplierId: b.supplierId, status: 'SENT', lines: { create: b.lines.map((l) => ({ ingredientId: l.ingredientId, quantity: dec(l.quantity), unitCost: dec(l.unitCost) })) } }, include: { lines: true } });
  await audit(req, 'po.create', 'PurchaseOrder', po.id);
  res.status(201).json(po);
}));
inventoryRouter.post('/purchase-orders/:id/receive', ...guard, wrap(async (req, res) => {
  const po = await prisma.$transaction(async (tx) => {
    const claimed = await tx.purchaseOrder.updateMany({ where: { id: req.params.id, status: { in: ['SENT', 'DRAFT'] } }, data: { status: 'RECEIVED', receivedAt: new Date() } });
    if (!claimed.count) throw conflict('This purchase order was already received or cancelled');
    const lines = await tx.purchaseOrderLine.findMany({ where: { poId: req.params.id } });
    for (const l of lines) {
      await tx.ingredient.update({ where: { id: l.ingredientId }, data: { stock: { increment: l.quantity }, costPerUnit: l.unitCost } });
      await tx.stockMovement.create({ data: { ingredientId: l.ingredientId, type: 'RECEIPT', quantity: l.quantity, reference: req.params.id, note: 'Purchase order received' } });
    }
    return tx.purchaseOrder.findUniqueOrThrow({ where: { id: req.params.id }, include: { lines: true } });
  });
  await audit(req, 'po.receive', 'PurchaseOrder', po.id);
  res.json(po);
}));

/** Suggested reorder quantity: average daily usage over last 14 days × 7 days cover − stock. Computed from the ledger. */
inventoryRouter.get('/reorder/suggestions', ...guard, wrap(async (_req, res) => {
  const since = new Date(Date.now() - 14 * 864e5);
  const use = await prisma.stockMovement.groupBy({ by: ['ingredientId'], where: { type: 'CONSUMPTION', createdAt: { gte: since } }, _sum: { quantity: true } });
  const ings = await prisma.ingredient.findMany();
  res.json(ings.map((i) => {
    const perDay = Math.abs(Number(use.find((u) => u.ingredientId === i.id)?._sum.quantity ?? 0)) / 14;
    const target = Math.max(perDay * 7, Number(i.reorderLevel) * 2);
    return { ingredientId: i.id, name: i.name, unit: i.unit, stock: Number(i.stock), avgDailyUse: Number(perDay.toFixed(3)), suggestedOrder: Math.max(0, Number((target - Number(i.stock)).toFixed(2))) };
  }).filter((s) => s.suggestedOrder > 0));
}));
