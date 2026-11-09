import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import multer from 'multer';
import { z } from 'zod';
import { prisma, dec } from '../db.js';
import { attachAuth, requirePerm } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { badRequest, notFound, pageQuery, paged, paginate, parse, slugify, wrap } from '../lib/http.js';
import { csvParse, csvStringify } from '../lib/csv.js';
import { config } from '../config.js';
import { cloudinaryConfigured, uploadToCloudinary } from '../services/storage.js';

export const menuRouter = Router();
export const productRouter = Router();
export const categoryRouter = Router();
export const uploadRouter = Router();

const guard = [attachAuth, requirePerm('menu.manage')];
const hhmm = z.string().regex(/^\d{2}:\d{2}$/).nullish().or(z.literal(''));

// ───────── menus ─────────
const menuBody = z.object({ name: z.string().trim().min(1).max(80), description: z.string().max(500).nullish(), isActive: z.boolean().default(true), availableFrom: hhmm, availableTo: hhmm, sortOrder: z.number().int().default(0) });
menuRouter.get('/', attachAuth, requirePerm('menu.manage', 'orders.view'), wrap(async (_req, res) => {
  res.json(await prisma.menu.findMany({ orderBy: { sortOrder: 'asc' }, include: { categories: { orderBy: { sortOrder: 'asc' }, include: { _count: { select: { products: true } } } } } }));
}));
menuRouter.post('/', ...guard, wrap(async (req, res) => {
  const b = parse(menuBody, req.body);
  const m = await prisma.menu.create({ data: { ...b, availableFrom: b.availableFrom || null, availableTo: b.availableTo || null } });
  await audit(req, 'menu.create', 'Menu', m.id);
  res.status(201).json(m);
}));
menuRouter.put('/:id', ...guard, wrap(async (req, res) => {
  const b = parse(menuBody.partial(), req.body);
  const m = await prisma.menu.update({ where: { id: req.params.id }, data: { ...b, availableFrom: b.availableFrom || null, availableTo: b.availableTo || null } }).catch(() => null);
  if (!m) throw notFound('Menu');
  await audit(req, 'menu.update', 'Menu', m.id);
  res.json(m);
}));
menuRouter.delete('/:id', ...guard, wrap(async (req, res) => {
  const used = await prisma.orderItem.count({ where: { product: { category: { menuId: req.params.id } } } });
  if (used) throw badRequest('This menu has products that appear in past orders. Deactivate it instead of deleting.');
  await prisma.menu.delete({ where: { id: req.params.id } }).catch(() => { throw notFound('Menu'); });
  await audit(req, 'menu.delete', 'Menu', req.params.id);
  res.json({ ok: true });
}));

// ───────── categories ─────────
const catBody = z.object({ menuId: z.string(), parentId: z.string().nullish(), name: z.string().trim().min(1).max(80), description: z.string().max(500).nullish(), imageUrl: z.string().nullish(), sortOrder: z.number().int().default(0), isActive: z.boolean().default(true) });
async function uniqueSlug(table: 'category' | 'product', base: string, ignoreId?: string) {
  let s = slugify(base), n = 1;
  for (;;) {
    const hit = await (prisma[table] as any).findUnique({ where: { slug: s } });
    if (!hit || hit.id === ignoreId) return s;
    s = `${slugify(base)}-${++n}`;
  }
}
categoryRouter.post('/', ...guard, wrap(async (req, res) => {
  const b = parse(catBody, req.body);
  const c = await prisma.category.create({ data: { ...b, slug: await uniqueSlug('category', b.name) } });
  await audit(req, 'category.create', 'Category', c.id);
  res.status(201).json(c);
}));
categoryRouter.put('/reorder', ...guard, wrap(async (req, res) => {
  const { ids } = parse(z.object({ ids: z.array(z.string()).min(1) }), req.body);
  await prisma.$transaction(ids.map((id, i) => prisma.category.update({ where: { id }, data: { sortOrder: i } })));
  res.json({ ok: true });
}));
categoryRouter.put('/:id', ...guard, wrap(async (req, res) => {
  const b = parse(catBody.partial(), req.body);
  const c = await prisma.category.update({ where: { id: req.params.id }, data: b }).catch(() => null);
  if (!c) throw notFound('Category');
  await audit(req, 'category.update', 'Category', c.id);
  res.json(c);
}));
categoryRouter.delete('/:id', ...guard, wrap(async (req, res) => {
  const n = await prisma.product.count({ where: { categoryId: req.params.id } });
  if (n) throw badRequest(`Move or delete the ${n} product(s) in this category first`);
  await prisma.category.delete({ where: { id: req.params.id } }).catch(() => { throw notFound('Category'); });
  await audit(req, 'category.delete', 'Category', req.params.id);
  res.json({ ok: true });
}));

// ───────── products ─────────
const money = z.number().min(0).max(100000);
export const PROTEIN_KEYS = ['chicken', 'pork', 'beef', 'lamb', 'goat', 'duck', 'turkey', 'fish', 'prawn', 'crab', 'squid', 'egg', 'other'] as const;
const productBody = z.object({
  categoryId: z.string(), name: z.string().trim().min(1).max(120), description: z.string().max(2000).nullish(),
  price: money, discountPrice: money.nullish(), isVegetarian: z.boolean().default(false), isVegan: z.boolean().default(false),
  allergens: z.array(z.string().max(40)).max(20).default([]), proteins: z.array(z.enum(PROTEIN_KEYS)).max(13).default([]), prepMinutes: z.number().int().min(1).max(240).default(15),
  isAvailable: z.boolean().default(true), isFeatured: z.boolean().default(false), isChefPick: z.boolean().default(false), isPublished: z.boolean().default(true),
  availableFrom: hhmm, availableTo: hhmm, sortOrder: z.number().int().default(0), translations: z.record(z.string(), z.object({ name: z.string().optional(), description: z.string().optional() })).default({}),
  images: z.array(z.object({ url: z.string().min(1), alt: z.string().max(200).nullish() })).max(12).optional(),
  variants: z.array(z.object({ name: z.string().min(1).max(60), priceDelta: z.number() })).max(12).optional(),
  addonGroups: z.array(z.object({ name: z.string().min(1).max(60), minSelect: z.number().int().min(0).default(0), maxSelect: z.number().int().min(1).default(1), addons: z.array(z.object({ name: z.string().min(1).max(60), price: z.number().min(0) })).max(30) })).max(10).optional(),
  recipe: z.array(z.object({ ingredientId: z.string(), quantity: z.number().positive() })).max(40).optional(),
}).refine((p) => p.discountPrice == null || p.discountPrice <= p.price, { message: 'Discount price cannot exceed the regular price', path: ['discountPrice'] });

const productInclude = {
  images: { orderBy: { sortOrder: 'asc' as const } }, variants: { orderBy: { sortOrder: 'asc' as const } },
  addonGroups: { include: { addons: true } }, recipe: { include: { ingredient: true } }, category: true,
};

function writeData(b: z.infer<typeof productBody>) {
  const { images, variants, addonGroups, recipe, ...rest } = b;
  return {
    scalar: { ...rest, price: dec(rest.price), discountPrice: rest.discountPrice == null ? null : dec(rest.discountPrice), availableFrom: rest.availableFrom || null, availableTo: rest.availableTo || null },
    images, variants, addonGroups, recipe,
  };
}

productRouter.get('/', attachAuth, requirePerm('menu.manage', 'orders.view', 'orders.create'), wrap(async (req, res) => {
  const q = parse(pageQuery.extend({ categoryId: z.string().optional(), available: z.enum(['true', 'false']).optional() }), req.query);
  const where: any = {};
  if (q.q) where.name = { contains: q.q, mode: 'insensitive' };
  if (q.categoryId) where.categoryId = q.categoryId;
  if (q.available) where.isAvailable = q.available === 'true';
  const [items, total] = await Promise.all([
    prisma.product.findMany({ where, ...paginate(q), orderBy: q.sort === 'price' ? { price: q.dir } : q.sort === 'name' ? { name: q.dir } : [{ categoryId: 'asc' }, { sortOrder: 'asc' }], include: productInclude }),
    prisma.product.count({ where }),
  ]);
  res.json(paged(items, total, q));
}));
productRouter.get('/export.csv', ...guard, wrap(async (_req, res) => {
  const ps = await prisma.product.findMany({ include: { category: true }, orderBy: [{ categoryId: 'asc' }, { sortOrder: 'asc' }] });
  res.type('text/csv').attachment('menu.csv').send(csvStringify([
    ['category', 'name', 'description', 'price', 'discountPrice', 'vegetarian', 'vegan', 'allergens', 'proteins', 'prepMinutes', 'available'],
    ...ps.map((p) => [p.category.name, p.name, p.description ?? '', p.price, p.discountPrice ?? '', p.isVegetarian, p.isVegan, p.allergens.join('|'), p.proteins.join('|'), p.prepMinutes, p.isAvailable]),
  ]));
}));
productRouter.post('/import', ...guard, wrap(async (req, res) => {
  const { csv, menuId } = parse(z.object({ csv: z.string().min(1).max(2_000_000), menuId: z.string().optional() }), req.body);
  const rows = csvParse(csv);
  const [head, ...data] = rows;
  if (!head) throw badRequest('The file is empty');
  const idx = (n: string) => head.map((h) => h.trim().toLowerCase()).indexOf(n.toLowerCase());
  for (const need of ['category', 'name', 'price']) if (idx(need) < 0) throw badRequest(`Missing required column "${need}"`);
  const menu = menuId ? await prisma.menu.findUnique({ where: { id: menuId } }) : await prisma.menu.findFirst({ orderBy: { sortOrder: 'asc' } });
  if (!menu) throw badRequest('Create a menu first');
  let created = 0, updated = 0; const errors: string[] = [];
  for (const [i, r] of data.entries()) {
    if (r.every((c) => !c.trim())) continue;
    const get = (n: string) => (idx(n) >= 0 ? (r[idx(n)] ?? '').trim() : '');
    const price = Number(get('price'));
    if (!get('name') || !get('category') || !isFinite(price) || price < 0) { errors.push(`Row ${i + 2}: name, category and a valid price are required`); continue; }
    let cat = await prisma.category.findFirst({ where: { menuId: menu.id, name: { equals: get('category'), mode: 'insensitive' } } });
    cat ??= await prisma.category.create({ data: { menuId: menu.id, name: get('category'), slug: await uniqueSlug('category', get('category')) } });
    const existing = await prisma.product.findFirst({ where: { categoryId: cat.id, name: { equals: get('name'), mode: 'insensitive' } } });
    const bool = (n: string) => ['true', '1', 'yes', 'y'].includes(get(n).toLowerCase());
    const data2 = {
      description: get('description') || null, price: dec(price), discountPrice: get('discountPrice') ? dec(Number(get('discountPrice'))) : null,
      isVegetarian: bool('vegetarian'), isVegan: bool('vegan'), proteins: get('proteins') ? get('proteins').split('|').map((x) => x.trim().toLowerCase()).filter((x) => (PROTEIN_KEYS as readonly string[]).includes(x)) : [], allergens: get('allergens') ? get('allergens').split('|').map((x) => x.trim()).filter(Boolean) : [],
      prepMinutes: Number(get('prepMinutes')) || 15, isAvailable: idx('available') < 0 ? true : bool('available'),
    };
    if (existing) { await prisma.product.update({ where: { id: existing.id }, data: data2 }); updated++; }
    else { await prisma.product.create({ data: { ...data2, name: get('name'), categoryId: cat.id, slug: await uniqueSlug('product', get('name')) } }); created++; }
  }
  await audit(req, 'menu.import', 'Product', undefined, { created, updated, errors: errors.length });
  res.json({ created, updated, errors });
}));
productRouter.get('/:id', attachAuth, requirePerm('menu.manage', 'orders.view'), wrap(async (req, res) => {
  const p = await prisma.product.findUnique({ where: { id: req.params.id }, include: productInclude });
  if (!p) throw notFound('Product');
  res.json(p);
}));
productRouter.post('/', ...guard, wrap(async (req, res) => {
  const b = parse(productBody, req.body);
  const w = writeData(b);
  const p = await prisma.product.create({
    data: {
      ...w.scalar, slug: await uniqueSlug('product', b.name),
      images: { create: (w.images ?? []).map((x, i) => ({ ...x, sortOrder: i })) },
      variants: { create: (w.variants ?? []).map((x, i) => ({ name: x.name, priceDelta: dec(x.priceDelta), sortOrder: i })) },
      addonGroups: { create: (w.addonGroups ?? []).map((g) => ({ name: g.name, minSelect: g.minSelect, maxSelect: g.maxSelect, addons: { create: g.addons.map((a) => ({ name: a.name, price: dec(a.price) })) } })) },
      recipe: { create: (w.recipe ?? []).map((r) => ({ ingredientId: r.ingredientId, quantity: dec(r.quantity) })) },
    } as any,
    include: productInclude,
  });
  await audit(req, 'product.create', 'Product', p.id);
  res.status(201).json(p);
}));
productRouter.put('/:id', ...guard, wrap(async (req, res) => {
  const b = parse(productBody, req.body);
  const w = writeData(b);
  const id = req.params.id;
  if (!(await prisma.product.findUnique({ where: { id } }))) throw notFound('Product');
  const p = await prisma.$transaction(async (tx) => {
    // replace nested collections atomically
    if (w.images) { await tx.productImage.deleteMany({ where: { productId: id } }); }
    if (w.variants) { await tx.productVariant.deleteMany({ where: { productId: id } }); }
    if (w.addonGroups) { await tx.addonGroup.deleteMany({ where: { productId: id } }); }
    if (w.recipe) { await tx.recipeLine.deleteMany({ where: { productId: id } }); }
    return tx.product.update({
      where: { id },
      data: {
        ...w.scalar,
        ...(w.images ? { images: { create: w.images.map((x, i) => ({ ...x, sortOrder: i })) } } : {}),
        ...(w.variants ? { variants: { create: w.variants.map((x, i) => ({ name: x.name, priceDelta: dec(x.priceDelta), sortOrder: i })) } } : {}),
        ...(w.addonGroups ? { addonGroups: { create: w.addonGroups.map((g) => ({ name: g.name, minSelect: g.minSelect, maxSelect: g.maxSelect, addons: { create: g.addons.map((a) => ({ name: a.name, price: dec(a.price) })) } })) } } : {}),
        ...(w.recipe ? { recipe: { create: w.recipe.map((r) => ({ ingredientId: r.ingredientId, quantity: dec(r.quantity) })) } } : {}),
      } as any,
      include: productInclude,
    });
  });
  await audit(req, 'product.update', 'Product', id);
  res.json(p);
}));
productRouter.patch('/:id/availability', attachAuth, requirePerm('menu.manage', 'kitchen.manage'), wrap(async (req, res) => {
  const { isAvailable } = parse(z.object({ isAvailable: z.boolean() }), req.body);
  const p = await prisma.product.update({ where: { id: req.params.id }, data: { isAvailable } }).catch(() => null);
  if (!p) throw notFound('Product');
  await audit(req, 'product.availability', 'Product', p.id, { isAvailable });
  res.json(p);
}));
productRouter.post('/:id/duplicate', ...guard, wrap(async (req, res) => {
  const src = await prisma.product.findUnique({ where: { id: req.params.id }, include: productInclude });
  if (!src) throw notFound('Product');
  const copy = await prisma.product.create({
    data: {
      categoryId: src.categoryId, name: `${src.name} (copy)`, slug: await uniqueSlug('product', `${src.name} copy`), description: src.description,
      price: src.price, discountPrice: src.discountPrice, isVegetarian: src.isVegetarian, isVegan: src.isVegan, allergens: src.allergens, proteins: src.proteins,
      prepMinutes: src.prepMinutes, isAvailable: false, isPublished: false, translations: src.translations as any,
      images: { create: src.images.map((i) => ({ url: i.url, alt: i.alt, sortOrder: i.sortOrder })) },
      variants: { create: src.variants.map((v) => ({ name: v.name, priceDelta: v.priceDelta, sortOrder: v.sortOrder })) },
      addonGroups: { create: src.addonGroups.map((g) => ({ name: g.name, minSelect: g.minSelect, maxSelect: g.maxSelect, addons: { create: g.addons.map((a) => ({ name: a.name, price: a.price })) } })) },
      recipe: { create: src.recipe.map((r) => ({ ingredientId: r.ingredientId, quantity: r.quantity })) },
    },
    include: productInclude,
  });
  await audit(req, 'product.duplicate', 'Product', copy.id, { from: src.id });
  res.status(201).json(copy);
}));
productRouter.delete('/:id', ...guard, wrap(async (req, res) => {
  const used = await prisma.orderItem.count({ where: { productId: req.params.id } });
  if (used) {
    // keep order history intact: hide instead of delete
    await prisma.product.update({ where: { id: req.params.id }, data: { isPublished: false, isAvailable: false } }).catch(() => { throw notFound('Product'); });
    await audit(req, 'product.archive', 'Product', req.params.id);
    return res.json({ ok: true, archived: true, message: 'This dish appears in past orders, so it was hidden instead of deleted.' });
  }
  await prisma.product.delete({ where: { id: req.params.id } }).catch(() => { throw notFound('Product'); });
  await audit(req, 'product.delete', 'Product', req.params.id);
  res.json({ ok: true });
}));

// ───────── uploads (validated by file signature; S3 when configured is a deployment concern, see docs) ─────────
export const UPLOAD_DIR = path.resolve(process.cwd(), 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
const SIGS: Array<[string, number[], string]> = [
  ['jpg', [0xff, 0xd8, 0xff], 'image/jpeg'], ['png', [0x89, 0x50, 0x4e, 0x47], 'image/png'], ['webp', [0x52, 0x49, 0x46, 0x46], 'image/webp'],
];
uploadRouter.post('/', attachAuth, requirePerm('menu.manage', 'cms.manage', 'settings.manage'), upload.single('file'), wrap(async (req, res) => {
  const f = req.file;
  if (!f) throw badRequest('Choose an image to upload');
  const sig = SIGS.find(([, bytes]) => bytes.every((b, i) => f.buffer[i] === b));
  if (!sig || (sig[0] === 'webp' && f.buffer.subarray(8, 12).toString() !== 'WEBP')) throw badRequest('Only JPEG, PNG or WebP images are allowed');
  if (cloudinaryConfigured()) return void res.status(201).json(await uploadToCloudinary(f.buffer, sig[2]));
  const name = `${crypto.randomBytes(12).toString('hex')}.${sig[0]}`;
  await fs.promises.writeFile(path.join(UPLOAD_DIR, name), f.buffer);
  const base = config.CDN_URL ? config.CDN_URL.replace(/\/$/, '') : '';
  res.status(201).json({ url: `${base}/uploads/${name}`, size: f.size });
}));
