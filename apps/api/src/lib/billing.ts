import type { RequestHandler } from 'express';
import { Prisma, type Invoice, type Plan, type Subscription } from '@prisma/client';
import { HttpError, prisma } from './core';
import { activeAdapter } from './payments';

type Tx = Prisma.TransactionClient;

/** Feature keys a plan can grant. Each one is enforced server-side where noted in the README. */
export const FEATURES = ['online_payments', 'reservations', 'crm', 'promotions', 'loyalty', 'inventory', 'marketing', 'multi_outlet', 'advanced_reports'] as const;
export type Feature = (typeof FEATURES)[number];

export interface Limits { maxOutlets: number | null; maxStaff: number | null; maxProducts: number | null }
export interface Entitlements {
  status: string;
  operational: boolean; // may take orders and bookings
  trial: boolean;
  features: Set<string>;
  limits: Limits;
  planCode: string;
  planName: string;
}

export const GRACE_DAYS = Number(process.env.BILLING_GRACE_DAYS ?? 7);
const DAY = 86_400_000;
const OPERATIONAL = ['TRIALING', 'ACTIVE', 'PAST_DUE'];

export function addMonths(d: Date, n: number): Date {
  const r = new Date(d);
  const day = r.getUTCDate();
  r.setUTCDate(1);
  r.setUTCMonth(r.getUTCMonth() + n);
  const last = new Date(Date.UTC(r.getUTCFullYear(), r.getUTCMonth() + 1, 0)).getUTCDate();
  r.setUTCDate(Math.min(day, last)); // Jan 31 + 1 month = Feb 28/29, not March 3
  return r;
}

const monthly = (p: Pick<Plan, 'priceCents' | 'intervalMonths'>) => p.priceCents / p.intervalMonths;
export const limitsOf = (p: Plan): Limits => {
  const l = (p.limits ?? {}) as Record<string, number | null>;
  return { maxOutlets: l.maxOutlets ?? null, maxStaff: l.maxStaff ?? null, maxProducts: l.maxProducts ?? null };
};

export async function getEntitlements(tenantId: string): Promise<Entitlements> {
  const [sub, tenant] = await Promise.all([
    prisma.subscription.findUnique({ where: { tenantId }, include: { plan: true } }),
    prisma.tenant.findUnique({ where: { id: tenantId } }),
  ]);
  if (!sub || !tenant) return { status: 'NONE', operational: false, trial: false, features: new Set(), limits: { maxOutlets: 0, maxStaff: 0, maxProducts: 0 }, planCode: '', planName: '' };
  const operational = OPERATIONAL.includes(sub.status);
  const trial = sub.status === 'TRIALING';
  const planLimits = limitsOf(sub.plan);
  return {
    status: sub.status, operational, trial, planCode: sub.plan.code, planName: sub.plan.name,
    // a trial is full access, so a business can try everything before choosing a plan
    features: new Set(trial ? FEATURES : operational ? sub.plan.features : []),
    // outlet count is the tenant's own setting (kept in step with the plan, adjustable by the super admin)
    limits: { maxOutlets: tenant.maxOutlets, maxStaff: trial ? null : planLimits.maxStaff, maxProducts: trial ? null : planLimits.maxProducts },
  };
}

function denied(e: Entitlements, feature: string): HttpError {
  if (!e.operational) return new HttpError(402, 'Your subscription is not active. Renew it in Billing to continue.', 'subscription_inactive');
  return new HttpError(402, `Your ${e.planName} plan does not include this feature. Upgrade in Billing to use it.`, 'plan_required', { feature: [feature] });
}

export async function assertFeature(tenantId: string | null | undefined, feature: Feature): Promise<Entitlements> {
  if (!tenantId) throw new HttpError(403, 'No tenant', 'forbidden');
  const e = await getEntitlements(tenantId);
  if (!e.operational || !e.features.has(feature)) throw denied(e, feature);
  return e;
}

export async function hasFeature(tenantId: string, feature: Feature): Promise<boolean> {
  const e = await getEntitlements(tenantId);
  return e.operational && e.features.has(feature);
}

export const tenantOfRestaurant = async (restaurantId: string) => (await prisma.restaurant.findUniqueOrThrow({ where: { id: restaurantId }, select: { tenantId: true } })).tenantId;

/** Route guard. Super admins (who belong to no tenant) pass. */
export const requireFeature = (feature: Feature): RequestHandler => (req, _res, next) => {
  if (req.user?.role === 'SUPER_ADMIN') return next();
  assertFeature(req.user?.tenantId, feature).then(() => next(), next);
};

export function assertWithin(limit: number | null, current: number, what: string, upgradeHint = true) {
  if (limit != null && current >= limit)
    throw new HttpError(402, `Your plan allows ${limit} ${what}.${upgradeHint ? ' Upgrade in Billing to add more.' : ''}`, 'limit_reached', { limit: [String(limit)] });
}

// ---------------- creating subscriptions ----------------
export async function startTrial(tx: Tx, tenantId: string, planCode?: string) {
  const fallback = (process.env.DEFAULT_PLAN_CODE ?? 'GROWTH').toUpperCase();
  // requested plan -> configured default -> cheapest active plan, so a bad link never blocks sign-up
  const plan = (planCode ? await tx.plan.findFirst({ where: { code: planCode.toUpperCase(), active: true } }) : null)
    ?? (await tx.plan.findFirst({ where: { code: fallback, active: true } }))
    ?? (await tx.plan.findFirst({ where: { active: true }, orderBy: { sort: 'asc' } }));
  if (!plan) throw new HttpError(500, 'No subscription plans are configured', 'internal');
  const now = new Date();
  const ends = new Date(now.getTime() + plan.trialDays * DAY);
  await tx.subscription.create({
    data: { tenantId, planId: plan.id, status: plan.trialDays > 0 ? 'TRIALING' : 'PAST_DUE', currentPeriodStart: now, currentPeriodEnd: ends, trialEndsAt: ends },
  });
  await tx.tenant.update({ where: { id: tenantId }, data: { plan: plan.code } });
}

// ---------------- invoices & payment ----------------
async function syncTenant(tx: Tx, tenantId: string, plan: Plan) {
  const l = limitsOf(plan);
  await tx.tenant.update({ where: { id: tenantId }, data: { plan: plan.code, ...(l.maxOutlets != null ? { maxOutlets: l.maxOutlets } : {}) } });
}

/** Creates the provider checkout for an open invoice (or returns the one already created). */
export async function checkoutForInvoice(invoiceId: string, returnPath = '/app/billing') {
  const adapter = activeAdapter();
  if (!adapter) throw new HttpError(503, 'Online payments are not configured on this server', 'provider_unavailable');
  const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId }, include: { tenant: { include: { users: { where: { role: 'OWNER' }, take: 1 } } } } });
  if (inv.status !== 'OPEN') throw new HttpError(409, 'This invoice is not open', 'bad_transition');
  const existing = await prisma.subscriptionPayment.findFirst({ where: { invoiceId, provider: adapter.name, status: 'PENDING', checkoutUrl: { not: null } } });
  if (existing) return existing;
  const pay = await prisma.subscriptionPayment.create({ data: { invoiceId, provider: adapter.name, amountCents: inv.amountCents, currency: inv.currency } });
  try {
    const owner = inv.tenant.users[0];
    const c = await adapter.createCheckout({
      paymentId: pay.id, amountCents: pay.amountCents, currency: pay.currency, description: `${inv.tenant.name}: ${inv.description}`,
      customer: { name: owner?.name ?? inv.tenant.name, phone: '' },
      returnUrl: `${process.env.WEB_ORIGIN ?? 'http://localhost:5173'}${returnPath}`,
    });
    return await prisma.subscriptionPayment.update({ where: { id: pay.id }, data: { providerRef: c.providerRef, checkoutUrl: c.url } });
  } catch (e) {
    await prisma.subscriptionPayment.update({ where: { id: pay.id }, data: { status: 'FAILED' } });
    throw e;
  }
}

/** Applies a paid invoice to the subscription. Called inside the transaction that marked the invoice PAID. */
export async function applyInvoicePaid(tx: Tx, inv: Invoice) {
  const sub = await tx.subscription.findUniqueOrThrow({ where: { id: inv.subscriptionId } });
  const plan = await tx.plan.findUniqueOrThrow({ where: { id: inv.planId } });
  const base = { status: 'ACTIVE' as const, planId: plan.id, pendingPlanId: null, canceledAt: null };
  if (inv.kind === 'UPGRADE') await tx.subscription.update({ where: { id: sub.id }, data: { ...base, pendingPlanId: sub.pendingPlanId === plan.id ? null : sub.pendingPlanId } });
  else await tx.subscription.update({ where: { id: sub.id }, data: { ...base, cancelAtPeriodEnd: false, currentPeriodStart: inv.periodStart, currentPeriodEnd: inv.periodEnd } });
  await syncTenant(tx, inv.tenantId, plan);
}

/** Handles a verified provider event for a subscription payment. Returns null if the reference isn't one of ours. */
export async function applySubscriptionPaymentEvent(tx: Tx, provider: string, ev: { kind: 'paid' | 'failed'; providerRef: string; providerPaymentId?: string; amountCents?: number }) {
  const pay = await tx.subscriptionPayment.findUnique({ where: { provider_providerRef: { provider, providerRef: ev.providerRef } }, include: { invoice: true } });
  if (!pay) return null;
  if (ev.kind === 'failed') {
    await tx.subscriptionPayment.updateMany({ where: { id: pay.id, status: 'PENDING' }, data: { status: 'FAILED' } });
    return 'applied' as const;
  }
  if (ev.amountCents != null && ev.amountCents !== pay.amountCents) {
    console.error(JSON.stringify({ event: 'subscription.amount_mismatch', paymentId: pay.id, expected: pay.amountCents, got: ev.amountCents }));
    return 'ignored' as const;
  }
  const claimed = await tx.subscriptionPayment.updateMany({ where: { id: pay.id, status: 'PENDING' }, data: { status: 'SUCCEEDED', paidAt: new Date(), providerPaymentId: ev.providerPaymentId } });
  if (!claimed.count) return 'ignored' as const;
  const paid = await tx.invoice.updateMany({ where: { id: pay.invoiceId, status: 'OPEN' }, data: { status: 'PAID', paidAt: new Date() } });
  if (!paid.count) {
    // money arrived for an invoice that was already voided/paid: record it loudly, change nothing
    console.error(JSON.stringify({ event: 'subscription.payment_for_closed_invoice', paymentId: pay.id, invoiceId: pay.invoiceId }));
    return 'ignored' as const;
  }
  await applyInvoicePaid(tx, { ...pay.invoice, status: 'PAID' });
  return 'applied' as const;
}

// ---------------- customer actions ----------------
export type ChangeResult =
  | { result: 'activated' }
  | { result: 'scheduled'; at: Date }
  | { result: 'unscheduled' }
  | { result: 'invoice'; invoiceId: string; amountCents: number };

async function voidAbandoned(tx: Tx, subscriptionId: string) {
  await tx.invoice.updateMany({ where: { subscriptionId, status: 'OPEN', kind: { not: 'RENEWAL' } }, data: { status: 'VOID' } });
}

/** Moves a tenant to another plan: upgrades are charged now (prorated), downgrades wait for the next renewal. */
export async function changePlan(tenantId: string, planCode: string): Promise<ChangeResult> {
  const now = new Date();
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Subscription" WHERE "tenantId" = ${tenantId} FOR UPDATE`;
    const sub = await tx.subscription.findUnique({ where: { tenantId }, include: { plan: true } });
    if (!sub) throw new HttpError(404, 'No subscription', 'not_found');
    const target = await tx.plan.findFirst({ where: { code: planCode.toUpperCase(), active: true } });
    if (!target) throw new HttpError(400, 'Unknown or unavailable plan', 'validation', { planCode: ['Unknown plan'] });
    const cur = sub.plan;
    if (target.currency !== cur.currency && sub.status === 'ACTIVE') throw new HttpError(409, 'This plan is billed in a different currency. Contact support to switch.', 'currency_mismatch');

    const startNew = async (kind: 'NEW' | 'UPGRADE', amountCents: number, periodStart: Date, periodEnd: Date, description: string): Promise<ChangeResult> => {
      await voidAbandoned(tx, sub.id);
      if (amountCents <= 0) {
        const inv = await tx.invoice.create({ data: { tenantId, subscriptionId: sub.id, planId: target.id, kind, amountCents: 0, currency: target.currency, status: 'PAID', paidAt: now, periodStart, periodEnd, dueAt: now, description } });
        await applyInvoicePaid(tx, inv);
        return { result: 'activated' };
      }
      const inv = await tx.invoice.create({ data: { tenantId, subscriptionId: sub.id, planId: target.id, kind, amountCents, currency: target.currency, periodStart, periodEnd, dueAt: now, description } });
      return { result: 'invoice', invoiceId: inv.id, amountCents };
    };

    if (sub.status === 'PAST_DUE') {
      const open = await tx.invoice.findFirst({ where: { subscriptionId: sub.id, status: 'OPEN' }, orderBy: { createdAt: 'desc' } });
      if (open && open.planId === target.id) return { result: 'invoice', invoiceId: open.id, amountCents: open.amountCents };
      throw new HttpError(409, 'Pay the outstanding invoice before changing plans.', 'invoice_outstanding');
    }

    if (sub.status === 'ACTIVE') {
      if (target.id === cur.id) {
        if (sub.pendingPlanId) { await tx.subscription.update({ where: { id: sub.id }, data: { pendingPlanId: null } }); return { result: 'unscheduled' }; }
        throw new HttpError(400, 'You are already on this plan', 'validation');
      }
      if (monthly(target) > monthly(cur)) {
        const total = sub.currentPeriodEnd.getTime() - sub.currentPeriodStart.getTime();
        const remaining = Math.max(0, sub.currentPeriodEnd.getTime() - now.getTime());
        // price difference for the rest of the period the customer has already paid for
        const amount = Math.round((monthly(target) - monthly(cur)) * cur.intervalMonths * (total > 0 ? remaining / total : 0));
        return startNew('UPGRADE', amount, now, sub.currentPeriodEnd, `Upgrade ${cur.name} → ${target.name} (prorated)`);
      }
      await tx.subscription.update({ where: { id: sub.id }, data: { pendingPlanId: target.id, cancelAtPeriodEnd: false } });
      return { result: 'scheduled', at: sub.currentPeriodEnd };
    }

    // trial, cancelled or expired: buy the plan outright, starting now
    return startNew('NEW', target.priceCents, now, addMonths(now, target.intervalMonths), `${target.name} plan, ${target.intervalMonths === 1 ? 'monthly' : `${target.intervalMonths} months`}`);
  });
}

export async function cancelAtPeriodEnd(tenantId: string, cancel: boolean) {
  const sub = await prisma.subscription.findUnique({ where: { tenantId } });
  if (!sub) throw new HttpError(404, 'No subscription', 'not_found');
  if (!['TRIALING', 'ACTIVE', 'PAST_DUE'].includes(sub.status)) throw new HttpError(409, 'This subscription has already ended', 'bad_transition');
  await prisma.subscription.update({ where: { id: sub.id }, data: { cancelAtPeriodEnd: cancel, ...(cancel ? { pendingPlanId: null } : {}) } });
}

// ---------------- renewal job ----------------
/**
 * Idempotent state machine, run hourly and on demand:
 *  - trial over  → invoice for the chosen plan (PAST_DUE until paid) or EXPIRED if cancelled
 *  - period over → apply a scheduled downgrade, invoice the next period, or CANCELED if cancelled
 *  - invoice unpaid past the grace period → EXPIRED
 * Cards are not charged automatically: each invoice is paid by the customer through the payment provider.
 */
export async function runBilling(now = new Date(), onlyTenantId?: string) {
  const out = { invoiced: 0, expired: 0, canceled: 0, activated: 0 };
  const subs = await prisma.subscription.findMany({ where: { status: { in: ['TRIALING', 'ACTIVE', 'PAST_DUE'] }, ...(onlyTenantId ? { tenantId: onlyTenantId } : {}) }, include: { plan: true, pendingPlan: true } });
  for (const s of subs) {
    try {
      await prisma.$transaction(async (tx) => {
        const claim = (from: string, data: Prisma.SubscriptionUpdateManyMutationInput) => tx.subscription.updateMany({ where: { id: s.id, status: from as any }, data });
        const bill = async (plan: Plan, kind: 'NEW' | 'RENEWAL', start: Date) => {
          const end = addMonths(start, plan.intervalMonths);
          try {
            const inv = await tx.invoice.create({ data: { tenantId: s.tenantId, subscriptionId: s.id, planId: plan.id, kind, amountCents: plan.priceCents, currency: plan.currency, periodStart: start, periodEnd: end, dueAt: start, description: `${plan.name} plan, ${plan.intervalMonths === 1 ? 'monthly' : `${plan.intervalMonths} months`}` } });
            if (plan.priceCents <= 0) {
              await tx.invoice.update({ where: { id: inv.id }, data: { status: 'PAID', paidAt: now } });
              await applyInvoicePaid(tx, { ...inv, status: 'PAID' });
              out.activated++;
              return 'free';
            }
            out.invoiced++;
            return 'billed';
          } catch (e: any) {
            if (e.code === 'P2002') return 'exists'; // already invoiced by an earlier run
            throw e;
          }
        };

        if (s.status === 'TRIALING' && s.trialEndsAt && s.trialEndsAt <= now) {
          if (s.cancelAtPeriodEnd) { if ((await claim('TRIALING', { status: 'EXPIRED', canceledAt: now })).count) out.expired++; return; }
          if ((await claim('TRIALING', { status: 'PAST_DUE' })).count) await bill(s.plan, 'NEW', s.trialEndsAt);
        } else if (s.status === 'ACTIVE' && s.currentPeriodEnd <= now) {
          if (s.cancelAtPeriodEnd) { if ((await claim('ACTIVE', { status: 'CANCELED', canceledAt: now })).count) out.canceled++; return; }
          const next = s.pendingPlan?.active ? s.pendingPlan : s.plan; // a downgrade takes effect with the new period
          if ((await claim('ACTIVE', { status: 'PAST_DUE' })).count) await bill(next, 'RENEWAL', s.currentPeriodEnd);
        } else if (s.status === 'PAST_DUE') {
          const open = await tx.invoice.findFirst({ where: { subscriptionId: s.id, status: 'OPEN' }, orderBy: { dueAt: 'asc' } });
          if (open && open.dueAt.getTime() + GRACE_DAYS * DAY <= now.getTime()) {
            if ((await claim('PAST_DUE', { status: 'EXPIRED', canceledAt: now })).count) {
              await tx.invoice.updateMany({ where: { subscriptionId: s.id, status: 'OPEN' }, data: { status: 'VOID' } });
              out.expired++;
            }
          }
        }
      });
    } catch (e) {
      console.error(JSON.stringify({ event: 'billing.run_failed', subscriptionId: s.id, error: String(e) }));
    }
  }
  return out;
}

export type SubscriptionView = Subscription & { plan: Plan; pendingPlan: Plan | null };
