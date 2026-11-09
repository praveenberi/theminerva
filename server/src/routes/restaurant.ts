import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { attachAuth, requirePerm } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { pageQuery, paged, paginate, parse, wrap } from '../lib/http.js';
import { DEFAULTS, getSettings, setSetting, type SettingKey } from '../lib/settings.js';
import { integrationStatus } from '../services/integrations.js';

export const restaurantRouter = Router();

const hours = z.record(z.string(), z.object({ open: z.string().regex(/^\d{2}:\d{2}$/).optional(), close: z.string().regex(/^\d{2}:\d{2}$/).optional(), closed: z.boolean().optional() }));
const profile = z.object({
  name: z.string().trim().min(1).max(120), tagline: z.string().max(200).nullish(), description: z.string().max(4000).nullish(),
  story: z.string().max(8000).nullish(), phone: z.string().max(30).nullish(), email: z.string().email().nullish().or(z.literal('')),
  whatsapp: z.string().max(30).nullish(), address: z.string().max(300).nullish(),
  latitude: z.number().min(-90).max(90).nullish(), longitude: z.number().min(-180).max(180).nullish(),
  mapEmbedUrl: z.string().url().nullish().or(z.literal('')), currency: z.string().length(3), locale: z.string().min(2).max(10),
  timezone: z.string().min(3).max(60), logoUrl: z.string().nullish(), heroImageUrl: z.string().nullish(),
  social: z.record(z.string(), z.string()).optional(), openingHours: hours.optional(),
  seo: z.object({ title: z.string().max(70).optional(), description: z.string().max(170).optional(), ogImage: z.string().optional() }).optional(),
}).partial();

restaurantRouter.get('/', wrap(async (_req, res) => {
  res.json(await prisma.restaurant.findUnique({ where: { id: 'minerva' } }));
}));
restaurantRouter.put('/', attachAuth, requirePerm('settings.manage'), wrap(async (req, res) => {
  const b = parse(profile, req.body);
  try { new Intl.DateTimeFormat('en', { timeZone: b.timezone ?? 'UTC' }); } catch { return res.status(422).json({ error: { code: 'VALIDATION_ERROR', message: 'timezone: unknown timezone' } }); }
  const r = await prisma.restaurant.update({ where: { id: 'minerva' }, data: { ...b, email: b.email || null, mapEmbedUrl: b.mapEmbedUrl || null } as any });
  await audit(req, 'restaurant.update', 'Restaurant', 'minerva', { fields: Object.keys(b) });
  res.json(r);
}));

const SECTION_SCHEMAS: Record<SettingKey, z.ZodTypeAny> = {
  ordering: z.object({
    dineInEnabled: z.boolean(), takeawayEnabled: z.boolean(), deliveryEnabled: z.boolean(), guestCheckout: z.boolean(),
    taxRate: z.number().min(0).max(30), taxInclusive: z.boolean(), serviceChargePct: z.number().min(0).max(30), minOrder: z.number().min(0),
    tipOptions: z.array(z.number().min(0).max(100)).max(8), scheduledOrdersEnabled: z.boolean(),
  }).partial(),
  loyalty: z.object({
    enabled: z.boolean(), pointsPerCurrency: z.number().min(0).max(100), minRedeemPoints: z.number().int().min(1), pointValue: z.number().min(0.001).max(10),
    pointsExpiryDays: z.number().int().min(0), referralBonus: z.number().int().min(0), birthdayBonus: z.number().int().min(0),
    tiers: z.array(z.object({ name: z.string().min(1), minLifetime: z.number().int().min(0), multiplier: z.number().min(1).max(10) })).min(1),
  }).partial(),
  reservations: z.object({
    enabled: z.boolean(), slotMinutes: z.number().int().min(30).max(360), intervalMinutes: z.number().int().min(15).max(120),
    maxPartySize: z.number().int().min(1).max(100), advanceDays: z.number().int().min(1).max(365), depositPerGuest: z.number().min(0),
    depositFromGuests: z.number().int().min(0), minNoticeMinutes: z.number().int().min(0),
  }).partial(),
  payments: z.object({ enabledMethods: z.array(z.enum(['CARD', 'STRIPE', 'RAZORPAY', 'PAYNOW', 'UPI', 'CASH_ON_DELIVERY', 'CASH_AT_RESTAURANT'])) }).partial(),
  site: z.object({ multiOutlet: z.boolean(), defaultLanguage: z.string(), languages: z.array(z.string()), googleReviewsUrl: z.string(), whatsappOrderMessage: z.string() }).partial(),
  analytics: z.object({ gaMeasurementId: z.string().max(40), metaPixelId: z.string().max(40), searchConsoleToken: z.string().max(120) }).partial(),
  kds: z.object({ lateAfterMinutes: z.number().int().min(1).max(120) }).partial(),
};

restaurantRouter.get('/settings', attachAuth, requirePerm('orders.view', 'settings.manage'), wrap(async (_req, res) => {
  res.json(await getSettings());
}));
restaurantRouter.put('/settings', attachAuth, requirePerm('settings.manage'), wrap(async (req, res) => {
  const body = parse(z.record(z.string(), z.any()), req.body) as Record<string, any>;
  for (const key of Object.keys(body)) {
    if (!(key in DEFAULTS)) return res.status(422).json({ error: { code: 'VALIDATION_ERROR', message: `Unknown settings section "${key}"` } });
    const v = parse(SECTION_SCHEMAS[key as SettingKey], body[key]);
    await setSetting(key as SettingKey, v as object);
  }
  await audit(req, 'settings.update', 'Setting', undefined, { sections: Object.keys(body) });
  res.json(await getSettings());
}));

restaurantRouter.get('/integrations', attachAuth, requirePerm('integrations.manage'), wrap(async (_req, res) => {
  res.json(integrationStatus());
}));

restaurantRouter.get('/audit-logs', attachAuth, requirePerm('audit.view'), wrap(async (req, res) => {
  const q = parse(pageQuery, req.query);
  const where = q.q ? { OR: [{ action: { contains: q.q, mode: 'insensitive' as const } }, { entity: { contains: q.q, mode: 'insensitive' as const } }] } : {};
  const [items, total] = await Promise.all([
    prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, ...paginate(q), include: { user: { select: { name: true, role: true } } } }),
    prisma.auditLog.count({ where }),
  ]);
  res.json(paged(items, total, q));
}));

restaurantRouter.get('/notification-logs', attachAuth, requirePerm('settings.manage'), wrap(async (req, res) => {
  const q = parse(pageQuery, req.query);
  const [items, total] = await Promise.all([
    prisma.notificationLog.findMany({ orderBy: { createdAt: 'desc' }, ...paginate(q) }),
    prisma.notificationLog.count(),
  ]);
  res.json(paged(items, total, q));
}));

restaurantRouter.get('/notification-templates', attachAuth, requirePerm('settings.manage'), wrap(async (_req, res) => {
  const { DEFAULT_TEMPLATES } = await import('../services/notify.js');
  const custom = await prisma.notificationTemplate.findMany();
  res.json({ defaults: DEFAULT_TEMPLATES, custom });
}));
restaurantRouter.put('/notification-templates/:key', attachAuth, requirePerm('settings.manage'), wrap(async (req, res) => {
  const b = parse(z.object({ channel: z.enum(['EMAIL', 'SMS', 'WHATSAPP', 'IN_APP']), subject: z.string().max(200).optional(), body: z.string().min(1).max(2000) }), req.body);
  const { DEFAULT_TEMPLATES } = await import('../services/notify.js');
  if (!DEFAULT_TEMPLATES[req.params.key]) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Unknown template' } });
  const t = await prisma.notificationTemplate.upsert({ where: { key: req.params.key }, create: { key: req.params.key, ...b }, update: b });
  await audit(req, 'template.update', 'NotificationTemplate', req.params.key);
  res.json(t);
}));

restaurantRouter.get('/alerts', attachAuth, requirePerm('orders.view'), wrap(async (_req, res) => {
  const items = await prisma.staffNotification.findMany({ orderBy: { createdAt: 'desc' }, take: 50 });
  res.json({ items, unread: items.filter((i) => !i.readAt).length });
}));
restaurantRouter.post('/alerts/read', attachAuth, requirePerm('orders.view'), wrap(async (_req, res) => {
  await prisma.staffNotification.updateMany({ where: { readAt: null }, data: { readAt: new Date() } });
  res.json({ ok: true });
}));
