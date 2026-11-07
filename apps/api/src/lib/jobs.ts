import { prisma } from './core';
import { issueBirthdayVouchers } from './loyalty';
import { runBilling } from './billing';

/**
 * Scheduled work. Both jobs are idempotent (one birthday voucher per customer per year; billing only acts on
 * invoices, trials and grace periods that are due), so running them often, after a restart or from several
 * instances at once is safe. A long-running server calls them from timers (src/index.ts); on Vercel the cron
 * endpoint (/api/cron/run) calls them instead.
 */
export async function birthdays() {
  const outlets = await prisma.restaurant.findMany({ where: { loyaltyEnabled: true }, select: { id: true } });
  let failed = 0;
  for (const o of outlets) await issueBirthdayVouchers(o.id).catch((e) => { failed++; console.error('birthday run failed', o.id, e); });
  return { restaurants: outlets.length, failed };
}

export async function billingTick() {
  const r = await runBilling();
  if (r.invoiced || r.expired || r.canceled) console.log(JSON.stringify({ event: 'billing.run', ...r }));
  return r;
}
