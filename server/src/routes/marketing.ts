import { Router } from 'express';
import { z } from 'zod';
import { prisma, dec } from '../db.js';
import { attachAuth, requirePerm } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { badRequest, conflict, notFound, parse, wrap } from '../lib/http.js';
import { sendEmail, sendWhatsApp } from '../services/integrations.js';
import { segmentIds } from './customers.js';
import { config } from '../config.js';

export const marketingRouter = Router();
const guard = [attachAuth, requirePerm('marketing.manage')];
const hhmm = z.string().regex(/^\d{2}:\d{2}$/).nullish().or(z.literal(''));

// ───────── coupons ─────────
const couponBody = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{3,24}$/, 'Use 3–24 letters, numbers, - or _'), description: z.string().max(200).nullish(),
  type: z.enum(['PERCENT', 'FIXED', 'BOGO']), value: z.number().min(0).default(0), minSubtotal: z.number().min(0).default(0),
  categoryId: z.string().nullish(), customerId: z.string().nullish(), startsAt: z.coerce.date().nullish(), endsAt: z.coerce.date().nullish(),
  startTime: hhmm, endTime: hhmm, maxUses: z.number().int().min(1).nullish(), isActive: z.boolean().default(true),
}).refine((c) => c.type !== 'PERCENT' || (c.value > 0 && c.value <= 100), { message: 'Percentage must be between 0 and 100', path: ['value'] })
  .refine((c) => c.type !== 'FIXED' || c.value > 0, { message: 'Enter a discount amount', path: ['value'] })
  .refine((c) => !c.startsAt || !c.endsAt || c.endsAt > c.startsAt, { message: 'End must be after start', path: ['endsAt'] });

marketingRouter.get('/coupons', ...guard, wrap(async (_req, res) => {
  const cs = await prisma.coupon.findMany({ orderBy: { code: 'asc' } });
  const revenue = await prisma.order.groupBy({ by: ['couponId'], where: { couponId: { not: null }, status: 'COMPLETED' }, _sum: { total: true, discount: true }, _count: true });
  res.json(cs.map((c) => { const r = revenue.find((x) => x.couponId === c.id); return { ...c, status: c.endsAt && c.endsAt < new Date() ? 'EXPIRED' : c.startsAt && c.startsAt > new Date() ? 'SCHEDULED' : c.isActive ? 'ACTIVE' : 'PAUSED', completedOrders: r?._count ?? 0, revenue: r?._sum.total ?? 0, discountGiven: r?._sum.discount ?? 0 }; }));
}));
marketingRouter.post('/coupons', ...guard, wrap(async (req, res) => {
  const b = parse(couponBody, req.body);
  if (await prisma.coupon.findUnique({ where: { code: b.code } })) throw conflict('That code already exists');
  const c = await prisma.coupon.create({ data: { ...b, value: dec(b.value), minSubtotal: dec(b.minSubtotal), startTime: b.startTime || null, endTime: b.endTime || null } });
  await audit(req, 'coupon.create', 'Coupon', c.id);
  res.status(201).json(c);
}));
marketingRouter.put('/coupons/:id', ...guard, wrap(async (req, res) => {
  const b = parse(couponBody, req.body);
  const c = await prisma.coupon.update({ where: { id: req.params.id }, data: { ...b, value: dec(b.value), minSubtotal: dec(b.minSubtotal), startTime: b.startTime || null, endTime: b.endTime || null } }).catch(() => null);
  if (!c) throw notFound('Coupon');
  res.json(c);
}));
marketingRouter.delete('/coupons/:id', ...guard, wrap(async (req, res) => {
  const used = await prisma.order.count({ where: { couponId: req.params.id } });
  if (used) { await prisma.coupon.update({ where: { id: req.params.id }, data: { isActive: false } }); return res.json({ ok: true, deactivated: true }); }
  await prisma.coupon.delete({ where: { id: req.params.id } }).catch(() => { throw notFound('Coupon'); });
  res.json({ ok: true });
}));

// ───────── banners ─────────
const bannerBody = z.object({ title: z.string().trim().min(1).max(100), subtitle: z.string().max(200).nullish(), imageUrl: z.string().nullish(), linkUrl: z.string().max(300).nullish(), isActive: z.boolean().default(true), startsAt: z.coerce.date().nullish(), endsAt: z.coerce.date().nullish(), sortOrder: z.number().int().default(0) });
marketingRouter.get('/banners', ...guard, wrap(async (_req, res) => { res.json(await prisma.banner.findMany({ orderBy: { sortOrder: 'asc' } })); }));
marketingRouter.post('/banners', ...guard, wrap(async (req, res) => { res.status(201).json(await prisma.banner.create({ data: parse(bannerBody, req.body) })); }));
marketingRouter.put('/banners/:id', ...guard, wrap(async (req, res) => { res.json(await prisma.banner.update({ where: { id: req.params.id }, data: parse(bannerBody.partial(), req.body) }).catch(() => { throw notFound('Banner'); })); }));
marketingRouter.delete('/banners/:id', ...guard, wrap(async (req, res) => { await prisma.banner.delete({ where: { id: req.params.id } }).catch(() => { throw notFound('Banner'); }); res.json({ ok: true }); }));

// ───────── dynamic pricing / happy hour ─────────
const ruleBody = z.object({ name: z.string().trim().min(1).max(80), categoryId: z.string().nullish(), percentOff: z.number().min(1).max(90), startTime: hhmm, endTime: hhmm, days: z.array(z.number().int().min(0).max(6)).default([]), isActive: z.boolean().default(true) });
marketingRouter.get('/pricing-rules', ...guard, wrap(async (_req, res) => { res.json(await prisma.pricingRule.findMany()); }));
marketingRouter.post('/pricing-rules', ...guard, wrap(async (req, res) => { const b = parse(ruleBody, req.body); res.status(201).json(await prisma.pricingRule.create({ data: { ...b, percentOff: dec(b.percentOff), startTime: b.startTime || null, endTime: b.endTime || null } })); }));
marketingRouter.put('/pricing-rules/:id', ...guard, wrap(async (req, res) => { const b = parse(ruleBody.partial(), req.body); res.json(await prisma.pricingRule.update({ where: { id: req.params.id }, data: { ...b, percentOff: b.percentOff === undefined ? undefined : dec(b.percentOff), startTime: b.startTime || null, endTime: b.endTime || null } }).catch(() => { throw notFound('Rule'); })); }));
marketingRouter.delete('/pricing-rules/:id', ...guard, wrap(async (req, res) => { await prisma.pricingRule.delete({ where: { id: req.params.id } }).catch(() => { throw notFound('Rule'); }); res.json({ ok: true }); }));

// ───────── campaigns ─────────
export const campaignRouter = Router();
const campBody = z.object({ name: z.string().trim().min(1).max(100), channel: z.enum(['EMAIL', 'WHATSAPP']), segment: z.enum(['ALL', 'NEW', 'RETURNING', 'VIP', 'INACTIVE', 'HIGH_SPEND', 'BIRTHDAY']).default('ALL'), subject: z.string().max(150).optional(), body: z.string().min(1).max(2000), couponCode: z.string().max(24).optional() });

campaignRouter.get('/', ...guard, wrap(async (_req, res) => { res.json(await prisma.campaign.findMany({ orderBy: { createdAt: 'desc' } })); }));
campaignRouter.post('/', ...guard, wrap(async (req, res) => {
  const b = parse(campBody, req.body);
  if (b.channel === 'EMAIL' && !b.subject) throw badRequest('Email campaigns need a subject');
  res.status(201).json(await prisma.campaign.create({ data: b }));
}));
campaignRouter.get('/analytics', ...guard, wrap(async (_req, res) => {
  const cs = await prisma.campaign.findMany({ where: { status: 'SENT' } });
  const out = [];
  for (const c of cs) {
    // attribution: completed orders with the campaign's coupon code placed after sending
    const coupon = c.couponCode ? await prisma.coupon.findUnique({ where: { code: c.couponCode } }) : null;
    const agg = coupon && c.sentAt ? await prisma.order.aggregate({ where: { couponId: coupon.id, status: 'COMPLETED', createdAt: { gte: c.sentAt } }, _sum: { total: true }, _count: true }) : null;
    out.push({ id: c.id, name: c.name, channel: c.channel, segment: c.segment, sent: c.sentCount, failed: c.failedCount, sentAt: c.sentAt, orders: agg?._count ?? 0, revenue: agg?._sum.total ?? 0 });
  }
  res.json(out);
}));
/** Sends only to customers who opted in and have not unsubscribed. Providers must be configured; otherwise rows are counted as failed, not "sent". */
campaignRouter.post('/:id/send', ...guard, wrap(async (req, res) => {
  const claimed = await prisma.campaign.updateMany({ where: { id: req.params.id, status: 'DRAFT' }, data: { status: 'SENDING' } });
  if (!claimed.count) throw conflict('This campaign was already sent');
  const c = await prisma.campaign.findUniqueOrThrow({ where: { id: req.params.id } });
  const ids = await segmentIds(c.segment);
  const customers = await prisma.customer.findMany({ where: { marketingConsent: true, unsubscribedAt: null, ...(ids ? { id: { in: ids } } : {}), ...(c.channel === 'EMAIL' ? { email: { not: null } } : { phone: { not: null } }) } });
  let sent = 0, failed = 0;
  for (const cu of customers) {
    const text = c.body.replace(/\{\{name\}\}/g, cu.name) + (c.couponCode ? `\nUse code ${c.couponCode}` : '');
    const unsub = `\n\nUnsubscribe: ${config.PUBLIC_WEB_URL}/unsubscribe?email=${encodeURIComponent(cu.email ?? '')}`;
    const r = c.channel === 'EMAIL' ? await sendEmail(cu.email!, c.subject ?? c.name, text + unsub) : await sendWhatsApp(cu.phone!, text + '\nReply STOP to opt out.');
    await prisma.notificationLog.create({ data: { channel: c.channel, event: `campaign:${c.id}`, recipient: (c.channel === 'EMAIL' ? cu.email : cu.phone)!, subject: c.subject, body: text, status: r.ok ? 'SENT' : r.skipped ? 'SKIPPED' : 'FAILED', error: r.error } });
    r.ok ? sent++ : failed++;
  }
  const up = await prisma.campaign.update({ where: { id: c.id }, data: { status: 'SENT', sentAt: new Date(), sentCount: sent, failedCount: failed } });
  await audit(req, 'campaign.send', 'Campaign', c.id, { recipients: customers.length, sent, failed });
  res.json({ ...up, recipients: customers.length, note: failed && !sent ? 'No messages were delivered — configure the email/WhatsApp provider first (Settings → Integrations).' : undefined });
}));
campaignRouter.delete('/:id', ...guard, wrap(async (req, res) => {
  const c = await prisma.campaign.findUnique({ where: { id: req.params.id } });
  if (!c) throw notFound('Campaign');
  if (c.status !== 'DRAFT') throw badRequest('Only drafts can be deleted');
  await prisma.campaign.delete({ where: { id: c.id } });
  res.json({ ok: true });
}));
