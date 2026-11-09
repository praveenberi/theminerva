import type { Tx } from '../db.js';
import { getSettings } from '../lib/settings.js';
import { toCents } from '../lib/money.js';

export function tierFor(lifetime: number, tiers: { name: string; minLifetime: number; multiplier: number }[]) {
  return [...tiers].sort((a, b) => b.minLifetime - a.minLifetime).find((t) => lifetime >= t.minLifetime) ?? tiers[0];
}

/** Points on completed orders. (orderId, reason) is unique, so a retry can never award twice. */
export async function applyCompletionRewards(tx: Tx, orderId: string) {
  const s = (await getSettings()).loyalty;
  const o = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
  if (!o.customerId) return;
  await tx.customer.update({ where: { id: o.customerId }, data: { lastOrderAt: new Date() } });
  if (!s.enabled) return;

  const cust = await tx.customer.findUniqueOrThrow({ where: { id: o.customerId } });
  const tier = tierFor(cust.lifetimePoints, s.tiers);
  const spendCents = toCents(o.subtotal) - toCents(o.discount);
  const points = Math.max(0, Math.floor((spendCents / 100) * s.pointsPerCurrency * tier.multiplier));

  const already = await tx.loyaltyTransaction.findUnique({ where: { orderId_reason: { orderId, reason: 'EARN' } } });
  if (points > 0 && !already) {
    await tx.loyaltyTransaction.create({ data: { customerId: cust.id, points, reason: 'EARN', orderId } });
    const lifetime = cust.lifetimePoints + points;
    await tx.customer.update({
      where: { id: cust.id },
      data: { loyaltyPoints: { increment: points }, lifetimePoints: { increment: points }, tier: tierFor(lifetime, s.tiers).name },
    });
  }

  // referral: first completed order of a referred customer rewards the referrer once
  if (cust.referredById && s.referralBonus > 0 && cust.referredById !== cust.id) {
    const prior = await tx.order.count({ where: { customerId: cust.id, status: 'COMPLETED', id: { not: orderId } } });
    if (prior === 0) {
      const exists = await tx.loyaltyTransaction.findFirst({ where: { customerId: cust.referredById, reason: 'REFERRAL', orderId } });
      if (!exists) {
        await tx.loyaltyTransaction.create({ data: { customerId: cust.referredById, points: s.referralBonus, reason: 'REFERRAL', orderId } });
        await tx.customer.update({ where: { id: cust.referredById }, data: { loyaltyPoints: { increment: s.referralBonus }, lifetimePoints: { increment: s.referralBonus } } });
      }
    }
  }
}
