import { Router } from 'express';
import { z } from 'zod';
import { HttpError, parse, prisma } from '../lib/core';
import { FEATURES, cancelAtPeriodEnd, changePlan, checkoutForInvoice, getEntitlements, limitsOf, runBilling } from '../lib/billing';
import { activeAdapter } from '../lib/payments';
import { authenticate, requireRole, wrap } from '../middleware/auth';

const planView = (p: any) => ({
  id: p.id, code: p.code, name: p.name, description: p.description, priceCents: p.priceCents, currency: p.currency, intervalMonths: p.intervalMonths,
  trialDays: p.trialDays, features: p.features, limits: limitsOf(p), active: p.active, sort: p.sort,
});

// ---------- public: pricing comes from the database, never from the page ----------
export const publicPlans = Router();
publicPlans.get('/', wrap(async (_req, res) => {
  res.json((await prisma.plan.findMany({ where: { active: true }, orderBy: { sort: 'asc' } })).map(planView));
}));

// ---------- tenant: what am I allowed to do? (any signed-in user) ----------
export const billing = Router();

billing.get('/entitlements', authenticate, wrap(async (req, res) => {
  if (req.user!.role === 'SUPER_ADMIN') return void res.json({ status: 'ACTIVE', operational: true, trial: false, features: [...FEATURES], limits: {}, planName: 'Platform admin', daysLeft: null });
  const tenantId = req.user!.tenantId!;
  await runBilling(new Date(), tenantId); // keep state fresh without waiting for the hourly job
  const [e, sub] = await Promise.all([getEntitlements(tenantId), prisma.subscription.findUnique({ where: { tenantId } })]);
  const daysLeft = sub ? Math.max(0, Math.ceil(((sub.status === 'TRIALING' ? sub.trialEndsAt ?? sub.currentPeriodEnd : sub.currentPeriodEnd).getTime() - Date.now()) / 86_400_000)) : null;
  res.json({ status: e.status, operational: e.operational, trial: e.trial, features: [...e.features], limits: e.limits, planCode: e.planCode, planName: e.planName, daysLeft, cancelAtPeriodEnd: sub?.cancelAtPeriodEnd ?? false });
}));

const owner = [authenticate, requireRole('OWNER')] as const;

billing.get('/billing', ...owner, wrap(async (req, res) => {
  const tenantId = req.user!.tenantId!;
  await runBilling(new Date(), tenantId);
  const [sub, invoices, plans, staff, outlets, products] = await Promise.all([
    prisma.subscription.findUnique({ where: { tenantId }, include: { plan: true, pendingPlan: true } }),
    prisma.invoice.findMany({ where: { tenantId }, orderBy: { createdAt: 'desc' }, take: 24, include: { plan: { select: { name: true } } } }),
    prisma.plan.findMany({ where: { active: true }, orderBy: { sort: 'asc' } }),
    prisma.user.count({ where: { tenantId, active: true, role: { not: 'OWNER' } } }),
    prisma.restaurant.count({ where: { tenantId } }),
    prisma.product.count({ where: { restaurantId: req.user!.restaurantId ?? '' } }),
  ]);
  if (!sub) throw new HttpError(404, 'No subscription', 'not_found');
  const e = await getEntitlements(tenantId);
  res.json({
    subscription: {
      status: sub.status, plan: planView(sub.plan), pendingPlan: sub.pendingPlan && planView(sub.pendingPlan), currentPeriodStart: sub.currentPeriodStart, currentPeriodEnd: sub.currentPeriodEnd,
      trialEndsAt: sub.trialEndsAt, cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
    },
    entitlements: { operational: e.operational, trial: e.trial, features: [...e.features], limits: e.limits },
    usage: { outlets, staff, products },
    invoices: invoices.map((i) => ({ id: i.id, number: i.number, description: i.description, kind: i.kind, amountCents: i.amountCents, currency: i.currency, status: i.status, dueAt: i.dueAt, paidAt: i.paidAt, plan: i.plan.name, createdAt: i.createdAt })),
    plans: plans.map(planView),
    paymentsAvailable: !!activeAdapter(),
  });
}));

billing.post('/billing/change', ...owner, wrap(async (req, res) => {
  const { planCode } = parse(z.object({ planCode: z.string().min(2).max(20) }), req.body);
  const r = await changePlan(req.user!.tenantId!, planCode);
  if (r.result !== 'invoice') return void res.json(r);
  const pay = await checkoutForInvoice(r.invoiceId);
  res.json({ ...r, payUrl: pay.checkoutUrl });
}));

billing.post('/billing/invoices/:id/pay', ...owner, wrap(async (req, res) => {
  const inv = await prisma.invoice.findFirst({ where: { id: req.params.id, tenantId: req.user!.tenantId! } });
  if (!inv) throw new HttpError(404, 'Not found', 'not_found');
  res.json({ payUrl: (await checkoutForInvoice(inv.id)).checkoutUrl });
}));

billing.post('/billing/cancel', ...owner, wrap(async (req, res) => { await cancelAtPeriodEnd(req.user!.tenantId!, true); res.json({ ok: true }); }));
billing.post('/billing/resume', ...owner, wrap(async (req, res) => { await cancelAtPeriodEnd(req.user!.tenantId!, false); res.json({ ok: true }); }));

// ---------- super admin: plans and subscriptions ----------
export const billingAdmin = Router();
const admin = [authenticate, requireRole('SUPER_ADMIN')] as const;

const limit = z.number().int().min(1).max(100_000).nullable();
const planSchema = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_]{2,20}$/, 'Use 2–20 capital letters, digits or _'),
  name: z.string().trim().min(2).max(40),
  description: z.string().max(300).default(''),
  priceCents: z.number().int().min(0).max(100_000_000),
  currency: z.string().length(3).toUpperCase(),
  intervalMonths: z.number().int().min(1).max(24),
  trialDays: z.number().int().min(0).max(90),
  limits: z.object({ maxOutlets: limit, maxStaff: limit, maxProducts: limit }),
  features: z.array(z.enum(FEATURES)).default([]),
  active: z.boolean().default(true),
  sort: z.number().int().min(0).max(1000).default(0),
});

billingAdmin.get('/plans', ...admin, wrap(async (_req, res) => {
  const [plans, counts] = await Promise.all([prisma.plan.findMany({ orderBy: { sort: 'asc' } }), prisma.subscription.groupBy({ by: ['planId'], _count: { _all: true } })]);
  res.json(plans.map((p) => ({ ...planView(p), subscribers: counts.find((c) => c.planId === p.id)?._count._all ?? 0 })));
}));

billingAdmin.post('/plans', ...admin, wrap(async (req, res) => {
  const d = parse(planSchema, req.body);
  try { res.status(201).json(planView(await prisma.plan.create({ data: d }))); } catch (e: any) { if (e.code === 'P2002') throw new HttpError(409, 'A plan with that code exists', 'duplicate'); throw e; }
}));

/** Price edits only affect invoices created from now on; feature and limit edits apply to current subscribers immediately. */
billingAdmin.put('/plans/:id', ...admin, wrap(async (req, res) => {
  const { code: _code, ...d } = parse(planSchema.omit({ code: true }).extend({ code: z.string().optional() }), req.body);
  try { res.json(planView(await prisma.plan.update({ where: { id: req.params.id }, data: d }))); } catch { throw new HttpError(404, 'Not found', 'not_found'); }
}));

billingAdmin.get('/subscriptions', ...admin, wrap(async (_req, res) => {
  const subs = await prisma.subscription.findMany({ include: { plan: true, tenant: { include: { restaurants: { select: { name: true }, take: 1, orderBy: { createdAt: 'asc' } } } } }, orderBy: { createdAt: 'desc' }, take: 300 });
  res.json(subs.map((s) => ({ tenantId: s.tenantId, name: s.tenant.restaurants[0]?.name ?? s.tenant.name, planCode: s.plan.code, status: s.status, currentPeriodEnd: s.currentPeriodEnd, trialEndsAt: s.trialEndsAt, cancelAtPeriodEnd: s.cancelAtPeriodEnd })));
}));

/** Manual overrides (comps, trial extensions, reinstating an account). They do not create invoices. */
billingAdmin.patch('/subscriptions/:tenantId', ...admin, wrap(async (req, res) => {
  const d = parse(z.object({ planCode: z.string().optional(), extendDays: z.number().int().min(1).max(365).optional(), status: z.enum(['ACTIVE', 'CANCELED', 'EXPIRED']).optional() }), req.body);
  const sub = await prisma.subscription.findUnique({ where: { tenantId: req.params.tenantId } });
  if (!sub) throw new HttpError(404, 'Not found', 'not_found');
  const plan = d.planCode ? await prisma.plan.findUnique({ where: { code: d.planCode.toUpperCase() } }) : null;
  if (d.planCode && !plan) throw new HttpError(400, 'Unknown plan', 'validation');
  const extend = d.extendDays ? d.extendDays * 86_400_000 : 0;
  await prisma.$transaction(async (tx) => {
    await tx.subscription.update({
      where: { id: sub.id },
      data: {
        ...(plan ? { planId: plan.id, pendingPlanId: null } : {}), ...(d.status ? { status: d.status, ...(d.status === 'ACTIVE' ? { cancelAtPeriodEnd: false, canceledAt: null } : {}) } : {}),
        ...(extend ? { currentPeriodEnd: new Date(Math.max(sub.currentPeriodEnd.getTime(), Date.now()) + extend), ...(sub.status === 'TRIALING' && sub.trialEndsAt ? { trialEndsAt: new Date(Math.max(sub.trialEndsAt.getTime(), Date.now()) + extend) } : {}) } : {}),
        // extending an overdue or ended account puts it back in good standing
        ...(extend && ['PAST_DUE', 'EXPIRED', 'CANCELED'].includes(sub.status) && !d.status ? { status: 'ACTIVE' as const } : {}),
      },
    });
    if (plan) await tx.tenant.update({ where: { id: sub.tenantId }, data: { plan: plan.code, ...(limitsOf(plan).maxOutlets != null ? { maxOutlets: limitsOf(plan).maxOutlets! } : {}) } });
    await tx.auditLog.create({ data: { actorId: req.user!.id, action: 'subscription.override', detail: { tenantId: sub.tenantId, ...d } } });
  });
  res.json({ ok: true });
}));

billingAdmin.post('/billing/run', ...admin, wrap(async (_req, res) => { res.json(await runBilling()); }));
