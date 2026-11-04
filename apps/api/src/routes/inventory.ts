import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { HttpError, parse, prisma } from '../lib/core';
import { requireFeature } from '../lib/billing';
import { MANAGE, authenticate, requireRole, rid, wrap } from '../middleware/auth';

export const inventory = Router();
// Path-scoped: this router is mounted at /api, so an unscoped guard would also block other roles' routes.
inventory.use(['/suppliers', '/ingredients', '/products/:id/recipe'], authenticate, requireRole(...MANAGE), requireFeature('inventory'));

const qty = z.number().finite().min(0).max(1_000_000);
const view = (i: any) => ({
  id: i.id, name: i.name, unit: i.unit, stockQty: Number(i.stockQty), lowThreshold: Number(i.lowThreshold),
  low: Number(i.stockQty) <= Number(i.lowThreshold), expiresAt: i.expiresAt, supplierId: i.supplierId, supplier: i.supplier?.name ?? null,
});

// ---------- suppliers ----------
inventory.get('/suppliers', wrap(async (req, res) => {
  res.json(await prisma.supplier.findMany({ where: { restaurantId: rid(req) }, orderBy: { name: 'asc' } }));
}));

inventory.post('/suppliers', wrap(async (req, res) => {
  const d = parse(z.object({ name: z.string().trim().min(1).max(80), phone: z.string().max(30).optional(), email: z.string().email().optional().or(z.literal('')) }), req.body);
  try {
    res.status(201).json(await prisma.supplier.create({ data: { ...d, email: d.email || null, restaurantId: rid(req) } }));
  } catch (e: any) {
    if (e.code === 'P2002') throw new HttpError(409, 'A supplier with that name exists', 'duplicate');
    throw e;
  }
}));

inventory.delete('/suppliers/:id', wrap(async (req, res) => {
  await prisma.supplier.deleteMany({ where: { id: req.params.id, restaurantId: rid(req) } });
  res.status(204).end();
}));

// ---------- ingredients ----------
const ingredientSchema = z.object({
  name: z.string().trim().min(1).max(80),
  unit: z.string().trim().min(1).max(12),
  lowThreshold: qty.default(0),
  expiresAt: z.string().datetime().nullable().optional(),
  supplierId: z.string().nullable().optional(),
});

async function checkSupplier(restaurantId: string, id?: string | null) {
  if (id && !(await prisma.supplier.count({ where: { id, restaurantId } })))
    throw new HttpError(400, 'Unknown supplier', 'validation', { supplierId: ['Unknown supplier'] });
}

inventory.get('/ingredients', wrap(async (req, res) => {
  const rows = await prisma.ingredient.findMany({ where: { restaurantId: rid(req) }, include: { supplier: true }, orderBy: { name: 'asc' } });
  res.json(rows.map(view));
}));

inventory.post('/ingredients', wrap(async (req, res) => {
  const d = parse(ingredientSchema, req.body);
  await checkSupplier(rid(req), d.supplierId);
  try {
    const i = await prisma.ingredient.create({ data: { ...d, expiresAt: d.expiresAt ? new Date(d.expiresAt) : null, restaurantId: rid(req) }, include: { supplier: true } });
    res.status(201).json(view(i));
  } catch (e: any) {
    if (e.code === 'P2002') throw new HttpError(409, 'An ingredient with that name exists', 'duplicate');
    throw e;
  }
}));

inventory.put('/ingredients/:id', wrap(async (req, res) => {
  const d = parse(ingredientSchema, req.body);
  await checkSupplier(rid(req), d.supplierId);
  const r = await prisma.ingredient.updateMany({ where: { id: req.params.id, restaurantId: rid(req) }, data: { ...d, expiresAt: d.expiresAt ? new Date(d.expiresAt) : null } });
  if (!r.count) throw new HttpError(404, 'Not found', 'not_found');
  res.json(view(await prisma.ingredient.findUniqueOrThrow({ where: { id: req.params.id }, include: { supplier: true } })));
}));

inventory.delete('/ingredients/:id', wrap(async (req, res) => {
  const r = await prisma.ingredient.deleteMany({ where: { id: req.params.id, restaurantId: rid(req) } });
  if (!r.count) throw new HttpError(404, 'Not found', 'not_found');
  res.status(204).end();
}));

/**
 * One endpoint for every manual stock change. All of them write a ledger row and move the balance atomically.
 *  PURCHASE  qty > 0  adds stock (goods received)
 *  WASTAGE   qty > 0  removes stock
 *  COUNT     counted  reconciles: sets stock to the counted quantity, ledger records the difference
 */
const stockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('PURCHASE'), qty: qty.positive(), note: z.string().max(200).optional(), expiresAt: z.string().datetime().optional() }),
  z.object({ type: z.literal('WASTAGE'), qty: qty.positive(), note: z.string().max(200).optional() }),
  z.object({ type: z.literal('COUNT'), counted: qty, note: z.string().max(200).optional() }),
]);

inventory.post('/ingredients/:id/stock', wrap(async (req, res) => {
  const d = parse(stockSchema, req.body);
  const restaurantId = rid(req);
  const out = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Ingredient" WHERE id = ${req.params.id} AND "restaurantId" = ${restaurantId} FOR UPDATE`;
    const ing = await tx.ingredient.findFirst({ where: { id: req.params.id, restaurantId } });
    if (!ing) throw new HttpError(404, 'Not found', 'not_found');
    const current = new Prisma.Decimal(ing.stockQty);
    const delta = d.type === 'PURCHASE' ? new Prisma.Decimal(d.qty)
      : d.type === 'WASTAGE' ? new Prisma.Decimal(d.qty).neg()
      : new Prisma.Decimal(d.counted).minus(current);
    await tx.stockMovement.create({ data: { restaurantId, ingredientId: ing.id, delta, reason: d.type === 'COUNT' ? 'ADJUSTMENT' : d.type, note: d.note, actorId: req.user!.id } });
    return tx.ingredient.update({
      where: { id: ing.id }, include: { supplier: true },
      data: { stockQty: { increment: delta }, ...(d.type === 'PURCHASE' && d.expiresAt ? { expiresAt: new Date(d.expiresAt) } : {}) },
    });
  });
  res.status(201).json(view(out));
}));

inventory.get('/ingredients/:id/movements', wrap(async (req, res) => {
  const rows = await prisma.stockMovement.findMany({
    where: { ingredientId: req.params.id, restaurantId: rid(req) }, orderBy: { createdAt: 'desc' }, take: 100,
  });
  res.json(rows.map((m) => ({ id: m.id, delta: Number(m.delta), reason: m.reason, note: m.note, orderId: m.orderId, createdAt: m.createdAt })));
}));

// ---------- recipes ----------
inventory.get('/products/:id/recipe', wrap(async (req, res) => {
  const rows = await prisma.recipeItem.findMany({ where: { productId: req.params.id, product: { restaurantId: rid(req) } }, include: { ingredient: true } });
  res.json(rows.map((r) => ({ ingredientId: r.ingredientId, name: r.ingredient.name, unit: r.ingredient.unit, qty: Number(r.qty) })));
}));

inventory.put('/products/:id/recipe', wrap(async (req, res) => {
  const d = parse(z.object({ items: z.array(z.object({ ingredientId: z.string(), qty: qty.positive() })).max(40) }), req.body);
  const restaurantId = rid(req);
  const ids = d.items.map((i) => i.ingredientId);
  if (new Set(ids).size !== ids.length) throw new HttpError(400, 'Each ingredient can appear once', 'validation');
  if (!(await prisma.product.count({ where: { id: req.params.id, restaurantId } }))) throw new HttpError(404, 'Not found', 'not_found');
  if ((await prisma.ingredient.count({ where: { restaurantId, id: { in: ids } } })) !== ids.length)
    throw new HttpError(400, 'Unknown ingredient', 'validation', { items: ['Unknown ingredient'] });
  await prisma.$transaction([
    prisma.recipeItem.deleteMany({ where: { productId: req.params.id } }),
    prisma.recipeItem.createMany({ data: d.items.map((i) => ({ productId: req.params.id, ingredientId: i.ingredientId, qty: i.qty })) }),
  ]);
  res.json({ ok: true });
}));
