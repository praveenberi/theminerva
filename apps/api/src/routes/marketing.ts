import { Router } from 'express';
import { z } from 'zod';
import { HttpError, env, parse, prisma } from '../lib/core';
import { requireFeature } from '../lib/billing';
import { issueBirthdayVouchers, loyaltyConfigSchema, parseLoyaltyConfig, redeemPoints, tierFor } from '../lib/loyalty';
import { adapterFor, messageAdapters, type Channel } from '../lib/messaging';
import { SEGMENTS, customersWithStats, inSegment } from '../lib/segments';
import { MANAGE, authenticate, requireRole, requireVerifiedEmail, rid, wrap } from '../middleware/auth';

export const marketing = Router();
const manage = [authenticate, requireRole(...MANAGE)] as const;
const owner = [authenticate, requireRole('OWNER')] as const;
const loyalty = requireFeature('loyalty');
const crm = requireFeature('crm');
const campaignsFeature = requireFeature('marketing');

// ---------- loyalty configuration ----------
marketing.get('/loyalty/config', ...manage, loyalty, wrap(async (req, res) => {
  const r = await prisma.restaurant.findUniqueOrThrow({ where: { id: rid(req) } });
  res.json({ enabled: r.loyaltyEnabled, config: parseLoyaltyConfig(r.loyaltyConfig) });
}));

marketing.put('/loyalty/config', ...owner, loyalty, wrap(async (req, res) => {
  const d = parse(z.object({ enabled: z.boolean(), config: loyaltyConfigSchema }).refine((v) => v.config.goldAt > v.config.silverAt, { message: 'Gold must need more points than Silver', path: ['config', 'goldAt'] }), req.body);
  await prisma.restaurant.update({ where: { id: rid(req) }, data: { loyaltyEnabled: d.enabled, loyaltyConfig: d.config } });
  await prisma.auditLog.create({ data: { restaurantId: rid(req), actorId: req.user!.id, action: 'loyalty.config', detail: d.config } });
  res.json(d);
}));

marketing.post('/loyalty/run-birthdays', ...manage, loyalty, wrap(async (req, res) => {
  res.json(await issueBirthdayVouchers(rid(req)));
}));

// ---------- customers: profile, points, vouchers ----------
marketing.get('/customers/:id', ...manage, crm, wrap(async (req, res) => {
  const restaurantId = rid(req);
  const c = await prisma.customer.findFirst({ where: { id: req.params.id, restaurantId } });
  if (!c) throw new HttpError(404, 'Not found', 'not_found');
  const [r, ledger, vouchers, referred] = await Promise.all([
    prisma.restaurant.findUniqueOrThrow({ where: { id: restaurantId } }),
    prisma.loyaltyTransaction.findMany({ where: { customerId: c.id }, orderBy: { createdAt: 'desc' }, take: 50 }),
    prisma.coupon.findMany({ where: { restaurantId, customerPhone: c.phone }, orderBy: { expiresAt: 'desc' }, take: 20 }),
    prisma.referral.groupBy({ by: ['status'], where: { referrerId: c.id }, _count: { _all: true } }),
  ]);
  const cfg = parseLoyaltyConfig(r.loyaltyConfig);
  res.json({
    id: c.id, name: c.name, phone: c.phone, email: c.email, birthday: c.birthday, marketingConsent: c.marketingConsent && !c.optedOutAt, optedOut: !!c.optedOutAt,
    points: c.loyaltyPoints, lifetimePoints: c.lifetimePoints, tier: tierFor(cfg, c.lifetimePoints).name, referralCode: c.referralCode,
    pointValueCents: cfg.pointValueCents, minRedeemPoints: cfg.minRedeemPoints,
    referrals: Object.fromEntries(referred.map((x) => [x.status, x._count._all])),
    ledger: ledger.map((l) => ({ id: l.id, delta: l.delta, reason: l.reason, note: l.note, createdAt: l.createdAt })),
    vouchers: vouchers.map((v) => ({ code: v.code, type: v.type, value: v.value, used: v.usageLimit != null && v.usedCount >= v.usageLimit, expiresAt: v.expiresAt, source: v.source?.split('-')[0] ?? null })),
  });
}));

marketing.post('/customers/:id/redeem', ...manage, loyalty, wrap(async (req, res) => {
  const { points } = parse(z.object({ points: z.number().int().min(1).max(1_000_000) }), req.body);
  res.status(201).json(await redeemPoints({ restaurantId: rid(req), customerId: req.params.id, points, actorId: req.user!.id }));
}));

marketing.post('/customers/:id/adjust', ...owner, loyalty, wrap(async (req, res) => {
  const d = parse(z.object({ points: z.number().int().min(-100_000).max(100_000).refine((n) => n !== 0, 'Cannot be zero'), note: z.string().trim().min(3).max(200) }), req.body);
  const restaurantId = rid(req);
  await prisma.$transaction(async (tx) => {
    // never lets a manual correction push the balance below zero
    const r = await tx.customer.updateMany({
      where: { id: req.params.id, restaurantId, ...(d.points < 0 ? { loyaltyPoints: { gte: -d.points } } : {}) },
      data: { loyaltyPoints: { increment: d.points }, ...(d.points > 0 ? { lifetimePoints: { increment: d.points } } : {}) },
    });
    if (!r.count) throw new HttpError(409, 'Customer not found or balance too low', 'insufficient_points');
    await tx.loyaltyTransaction.create({ data: { restaurantId, customerId: req.params.id, delta: d.points, reason: 'ADJUST', note: d.note, actorId: req.user!.id } });
  });
  res.json({ ok: true });
}));

/** Staff can fix a birthday or record an opt-out. Consent itself can only be given by the customer at checkout. */
marketing.patch('/customers/:id', ...manage, crm, wrap(async (req, res) => {
  const d = parse(z.object({ birthday: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(), optOut: z.literal(true).optional() }), req.body);
  const r = await prisma.customer.updateMany({
    where: { id: req.params.id, restaurantId: rid(req) },
    data: { ...(d.birthday !== undefined ? { birthday: d.birthday ? new Date(`${d.birthday}T00:00:00Z`) : null } : {}), ...(d.optOut ? { marketingConsent: false, optedOutAt: new Date() } : {}) },
  });
  if (!r.count) throw new HttpError(404, 'Not found', 'not_found');
  res.json({ ok: true });
}));

// ---------- campaigns ----------
marketing.get('/marketing/channels', ...manage, campaignsFeature, wrap(async (_req, res) => {
  const a = messageAdapters();
  res.json({ EMAIL: a.EMAIL?.name ?? null, WHATSAPP: a.WHATSAPP?.name ?? null });
}));

const campaignSchema = z.object({
  name: z.string().trim().min(2).max(80),
  channel: z.enum(['EMAIL', 'WHATSAPP']),
  segment: z.enum(SEGMENTS),
  subject: z.string().trim().max(120).regex(/^[^\r\n]*$/, 'No line breaks').optional(),
  body: z.string().trim().min(5).max(1000),
  couponCode: z.string().trim().toUpperCase().max(20).optional().or(z.literal('')),
}).refine((c) => c.channel !== 'EMAIL' || !!c.subject, { message: 'Email needs a subject', path: ['subject'] });

async function stats(campaign: { id: string; restaurantId: string; couponCode: string | null; sentAt: Date | null }) {
  const [byStatus, sentTo] = await Promise.all([
    prisma.campaignMessage.groupBy({ by: ['status'], where: { campaignId: campaign.id }, _count: { _all: true } }),
    campaign.sentAt && campaign.couponCode ? prisma.campaignMessage.findMany({ where: { campaignId: campaign.id, status: 'SENT' }, select: { customerId: true } }) : Promise.resolve([]),
  ]);
  const n = (s: string) => byStatus.find((x) => x.status === s)?._count._all ?? 0;
  let orders = 0, revenueCents = 0;
  if (campaign.sentAt && campaign.couponCode && sentTo.length) {
    // attribution: orders using this campaign's code, from customers who were actually messaged, after it went out
    const a = await prisma.order.aggregate({
      where: { restaurantId: campaign.restaurantId, couponCode: campaign.couponCode, customerId: { in: sentTo.map((x) => x.customerId) }, createdAt: { gte: campaign.sentAt }, status: { notIn: ['CANCELLED', 'PENDING_PAYMENT'] } },
      _count: { _all: true }, _sum: { totalCents: true },
    });
    orders = a._count._all; revenueCents = a._sum.totalCents ?? 0;
  }
  return { queued: n('QUEUED'), sent: n('SENT'), failed: n('FAILED'), orders, revenueCents };
}

marketing.get('/campaigns', ...manage, campaignsFeature, wrap(async (req, res) => {
  const list = await prisma.campaign.findMany({ where: { restaurantId: rid(req) }, orderBy: { createdAt: 'desc' }, take: 50 });
  res.json(await Promise.all(list.map(async (c) => ({ ...c, stats: await stats(c) }))));
}));

marketing.get('/campaigns/:id', ...manage, campaignsFeature, wrap(async (req, res) => {
  const c = await prisma.campaign.findFirst({ where: { id: req.params.id, restaurantId: rid(req) } });
  if (!c) throw new HttpError(404, 'Not found', 'not_found');
  const messages = await prisma.campaignMessage.findMany({ where: { campaignId: c.id }, include: { customer: { select: { name: true } } }, orderBy: { id: 'asc' }, take: 200 });
  res.json({ ...c, stats: await stats(c), messages: messages.map((m) => ({ id: m.id, name: m.customer.name, recipient: m.recipient, status: m.status, error: m.error, sentAt: m.sentAt })) });
}));

marketing.post('/campaigns', ...manage, campaignsFeature, wrap(async (req, res) => {
  const d = parse(campaignSchema, req.body);
  const restaurantId = rid(req);
  if (d.couponCode && !(await prisma.coupon.count({ where: { restaurantId, code: d.couponCode } })))
    throw new HttpError(400, 'That coupon code does not exist', 'validation', { couponCode: ['Unknown coupon'] });
  res.status(201).json(await prisma.campaign.create({ data: { ...d, couponCode: d.couponCode || null, restaurantId } }));
}));

marketing.delete('/campaigns/:id', ...manage, campaignsFeature, wrap(async (req, res) => {
  const r = await prisma.campaign.deleteMany({ where: { id: req.params.id, restaurantId: rid(req), status: 'DRAFT' } });
  if (!r.count) throw new HttpError(409, 'Only drafts can be deleted', 'bad_transition');
  res.status(204).end();
}));

const firstName = (n: string) => n.trim().split(/\s+/)[0] ?? n;

export async function processCampaign(campaignId: string) {
  const camp = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } });
  const adapter = adapterFor(camp.channel as Channel);
  for (;;) {
    const batch = await prisma.campaignMessage.findMany({ where: { campaignId, status: 'QUEUED' }, include: { customer: true }, take: 20 });
    if (!batch.length) break;
    for (const m of batch) {
      const unsub = `${process.env.PUBLIC_API_URL ?? `http://localhost:${env.port}`}/api/public/unsubscribe/${m.customer.unsubscribeToken}`;
      const text = `${camp.body.replace(/{{\s*name\s*}}/gi, firstName(m.customer.name)).replace(/{{\s*code\s*}}/gi, camp.couponCode ?? '')}\n\nStop receiving offers: ${unsub}`;
      try {
        // a message only becomes SENT when the provider accepted it
        const r = await adapter.send({ to: m.recipient, name: firstName(m.customer.name), subject: camp.subject ?? undefined, text });
        await prisma.campaignMessage.update({ where: { id: m.id }, data: { status: 'SENT', providerRef: r.providerRef, sentAt: new Date() } });
      } catch (e) {
        await prisma.campaignMessage.update({ where: { id: m.id }, data: { status: 'FAILED', error: (e instanceof Error ? e.message : 'Send failed').slice(0, 200) } });
      }
    }
  }
  await prisma.campaign.update({ where: { id: campaignId }, data: { status: 'SENT', sentAt: new Date() } });
}

marketing.post('/campaigns/:id/send', ...manage, requireVerifiedEmail, campaignsFeature, wrap(async (req, res) => {
  const restaurantId = rid(req);
  const camp = await prisma.campaign.findFirst({ where: { id: req.params.id, restaurantId } });
  if (!camp) throw new HttpError(404, 'Not found', 'not_found');
  adapterFor(camp.channel as Channel); // refuse up front when the channel isn't configured

  // consent is checked at send time: only customers who opted in and have not opted out since
  const eligible = (await customersWithStats(restaurantId)).filter((c) => c.marketingConsent && inSegment(c, camp.segment) && (camp.channel === 'EMAIL' ? !!c.email : !!c.phone));
  if (!eligible.length) throw new HttpError(400, 'No customers in this segment have agreed to marketing messages', 'no_recipients');

  const claimed = await prisma.campaign.updateMany({ where: { id: camp.id, status: 'DRAFT' }, data: { status: 'SENDING' } });
  if (!claimed.count) throw new HttpError(409, 'This campaign was already sent', 'bad_transition');
  await prisma.campaignMessage.createMany({
    data: eligible.map((c) => ({ campaignId: camp.id, customerId: c.id, recipient: camp.channel === 'EMAIL' ? c.email! : c.phone })), skipDuplicates: true,
  });
  void processCampaign(camp.id).catch((e) => console.error(JSON.stringify({ event: 'campaign.failed', campaignId: camp.id, error: String(e) })));
  res.status(202).json({ recipients: eligible.length });
}));
