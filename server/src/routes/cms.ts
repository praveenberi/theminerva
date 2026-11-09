import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { attachAuth, requirePerm } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { notFound, parse, wrap } from '../lib/http.js';

export const cmsRouter = Router();
const guard = [attachAuth, requirePerm('cms.manage')];

// content blocks with draft → publish workflow
cmsRouter.get('/blocks', ...guard, wrap(async (_req, res) => { res.json(await prisma.contentBlock.findMany({ orderBy: { key: 'asc' } })); }));
cmsRouter.put('/blocks/:key', ...guard, wrap(async (req, res) => {
  const b = parse(z.object({ title: z.string().max(160).optional(), body: z.record(z.string(), z.any()), publish: z.boolean().default(false) }), req.body) as { title?: string; body: any; publish: boolean };
  const key = req.params.key;
  if (!/^[a-z0-9._-]{2,60}$/.test(key)) throw notFound('Block');
  const cur = await prisma.contentBlock.findUnique({ where: { key } });
  const row = b.publish || !cur
    ? await prisma.contentBlock.upsert({ where: { key }, create: { key, title: b.title, body: b.body, isPublished: true }, update: { title: b.title, body: b.body, draft: null as any, isPublished: true } })
    : await prisma.contentBlock.update({ where: { key }, data: { draft: { title: b.title, body: b.body } } });
  await audit(req, b.publish ? 'cms.publish' : 'cms.draft', 'ContentBlock', key);
  res.json(row);
}));
cmsRouter.post('/blocks/:key/publish', ...guard, wrap(async (req, res) => {
  const cur = await prisma.contentBlock.findUnique({ where: { key: req.params.key } });
  if (!cur?.draft) throw notFound('Draft');
  const d = cur.draft as any;
  res.json(await prisma.contentBlock.update({ where: { key: cur.key }, data: { title: d.title ?? cur.title, body: d.body, draft: null as any } }));
}));

function crud<T extends 'galleryImage' | 'testimonial' | 'eventListing'>(path: string, model: T, schema: z.ZodTypeAny) {
  const m = (prisma as any)[model];
  cmsRouter.get(`/${path}`, ...guard, wrap(async (_req, res) => { res.json(await m.findMany({ orderBy: { id: 'asc' } })); }));
  cmsRouter.post(`/${path}`, ...guard, wrap(async (req, res) => { const r = await m.create({ data: parse(schema, req.body) }); await audit(req, `cms.${path}.create`, model, r.id); res.status(201).json(r); }));
  cmsRouter.put(`/${path}/:id`, ...guard, wrap(async (req, res) => { res.json(await m.update({ where: { id: req.params.id }, data: parse((schema as z.ZodObject<any>).partial(), req.body) }).catch(() => { throw notFound('Item'); })); }));
  cmsRouter.delete(`/${path}/:id`, ...guard, wrap(async (req, res) => { await m.delete({ where: { id: req.params.id } }).catch(() => { throw notFound('Item'); }); res.json({ ok: true }); }));
}
crud('gallery', 'galleryImage', z.object({ url: z.string().min(1), alt: z.string().trim().min(1, 'Alt text is required for accessibility').max(200), sortOrder: z.number().int().default(0), isPublished: z.boolean().default(true) }));
crud('testimonials', 'testimonial', z.object({ author: z.string().trim().min(1).max(80), quote: z.string().trim().min(1).max(600), rating: z.number().int().min(1).max(5).default(5), isPublished: z.boolean().default(true) }));
crud('events', 'eventListing', z.object({ title: z.string().trim().min(1).max(120), description: z.string().max(1500).nullish(), imageUrl: z.string().nullish(), eventDate: z.coerce.date().nullish(), isPublished: z.boolean().default(true) }));

// review moderation (feedback)
cmsRouter.get('/reviews', ...guard, wrap(async (_req, res) => { res.json(await prisma.review.findMany({ orderBy: { createdAt: 'desc' }, take: 200, include: { product: { select: { name: true } } } })); }));
cmsRouter.patch('/reviews/:id', ...guard, wrap(async (req, res) => {
  const b = parse(z.object({ isPublished: z.boolean() }), req.body);
  res.json(await prisma.review.update({ where: { id: req.params.id }, data: b }).catch(() => { throw notFound('Review'); }));
}));

// delivery zones
export const deliveryRouter = Router();
const zoneBody = z.object({ name: z.string().trim().min(1).max(80), postalPrefixes: z.array(z.string().max(8)).default([]), maxDistanceKm: z.number().min(0).nullish(), fee: z.number().min(0), perKmFee: z.number().min(0).default(0), minOrder: z.number().min(0).default(0), etaMinutes: z.number().int().min(5).max(240).default(45), isActive: z.boolean().default(true) });
deliveryRouter.get('/zones', attachAuth, requirePerm('orders.view'), wrap(async (_req, res) => { res.json(await prisma.deliveryZone.findMany()); }));
deliveryRouter.post('/zones', attachAuth, requirePerm('settings.manage', 'orders.manage'), wrap(async (req, res) => { res.status(201).json(await prisma.deliveryZone.create({ data: parse(zoneBody, req.body) as any })); }));
deliveryRouter.put('/zones/:id', attachAuth, requirePerm('settings.manage', 'orders.manage'), wrap(async (req, res) => { res.json(await prisma.deliveryZone.update({ where: { id: req.params.id }, data: parse(zoneBody.partial(), req.body) as any }).catch(() => { throw notFound('Zone'); })); }));
deliveryRouter.delete('/zones/:id', attachAuth, requirePerm('settings.manage', 'orders.manage'), wrap(async (req, res) => {
  const used = await prisma.order.count({ where: { deliveryZoneId: req.params.id } });
  if (used) { await prisma.deliveryZone.update({ where: { id: req.params.id }, data: { isActive: false } }); return res.json({ ok: true, deactivated: true }); }
  await prisma.deliveryZone.delete({ where: { id: req.params.id } }).catch(() => { throw notFound('Zone'); });
  res.json({ ok: true });
}));
deliveryRouter.get('/history', attachAuth, requirePerm('orders.manage', 'delivery.update'), wrap(async (req, res) => {
  const where: any = { type: 'DELIVERY', status: { in: ['COMPLETED', 'OUT_FOR_DELIVERY'] } };
  if (req.staff!.role === 'DELIVERY') where.driverId = req.staff!.id;
  res.json(await prisma.order.findMany({ where, orderBy: { createdAt: 'desc' }, take: 100, select: { id: true, number: true, status: true, deliveryAddress: true, createdAt: true, completedAt: true, driver: { select: { name: true } } } }));
}));
