import crypto from 'node:crypto';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { HttpError, prisma } from './core';
import { hasFeature } from './billing';

type Tx = Prisma.TransactionClient;

export const loyaltyConfigSchema = z.object({
  pointsPer100: z.number().min(0).max(100).default(1), // points per 100 currency units spent (after discounts)
  pointValueCents: z.number().int().min(0).max(100_000).default(100), // what one point is worth when redeemed
  minRedeemPoints: z.number().int().min(1).default(50),
  silverAt: z.number().int().min(1).default(500), // tiers use lifetime points earned
  goldAt: z.number().int().min(1).default(2000),
  silverMultiplier: z.number().min(1).max(10).default(1.25),
  goldMultiplier: z.number().min(1).max(10).default(1.5),
  referralBonusPoints: z.number().int().min(0).max(100_000).default(50), // given to BOTH friends
  referralMinOrderCents: z.number().int().min(0).default(10_000),
  referralMaxRewards: z.number().int().min(1).max(1000).default(20), // per referrer, stops farming
  birthdayEnabled: z.boolean().default(false),
  birthdayType: z.enum(['PERCENT', 'FIXED']).default('PERCENT'),
  birthdayValue: z.number().int().min(1).default(20),
  birthdayValidDays: z.number().int().min(1).max(60).default(7),
});
export type LoyaltyConfig = z.infer<typeof loyaltyConfigSchema>;
export const parseLoyaltyConfig = (raw: unknown): LoyaltyConfig => loyaltyConfigSchema.parse(raw ?? {});

export function tierFor(cfg: LoyaltyConfig, lifetime: number) {
  if (lifetime >= cfg.goldAt) return { name: 'Gold', multiplier: cfg.goldMultiplier };
  if (lifetime >= cfg.silverAt) return { name: 'Silver', multiplier: cfg.silverMultiplier };
  return { name: 'Member', multiplier: 1 };
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
export const randomCode = (n: number) => Array.from(crypto.randomBytes(n), (b) => ALPHABET[b % ALPHABET.length]).join('');

export async function ensureReferralCode(customerId: string): Promise<string> {
  const c = await prisma.customer.findUniqueOrThrow({ where: { id: customerId } });
  if (c.referralCode) return c.referralCode;
  for (let i = 0; i < 5; i++) {
    try {
      return (await prisma.customer.update({ where: { id: c.id }, data: { referralCode: randomCode(6) } })).referralCode!;
    } catch (e: any) {
      if (e.code !== 'P2002') throw e;
    }
  }
  throw new HttpError(500, 'Could not create referral code', 'internal');
}

async function credit(tx: Tx, p: { restaurantId: string; customerId: string; points: number; reason: 'EARN' | 'REFERRAL'; orderId: string; note?: string }) {
  if (p.points <= 0) return;
  // unique (order, customer, reason): a second attempt for the same order throws instead of paying twice
  await tx.loyaltyTransaction.create({ data: { restaurantId: p.restaurantId, customerId: p.customerId, delta: p.points, reason: p.reason, orderId: p.orderId, note: p.note } });
  await tx.customer.update({ where: { id: p.customerId }, data: { loyaltyPoints: { increment: p.points }, lifetimePoints: { increment: p.points } } });
}

/** Called inside the transaction that completes an order. */
export async function rewardCompletedOrder(tx: Tx, orderId: string) {
  const o = await tx.order.findUniqueOrThrow({ where: { id: orderId }, include: { restaurant: true } });
  if (!o.customerId || !o.restaurant.loyaltyEnabled) return;
  if (!(await hasFeature(o.restaurant.tenantId, 'loyalty'))) return; // plan no longer includes loyalty: no new points
  const cfg = parseLoyaltyConfig(o.restaurant.loyaltyConfig);
  const customer = await tx.customer.findUniqueOrThrow({ where: { id: o.customerId } });
  const spend = o.subtotalCents - o.discountCents;

  const mult = tierFor(cfg, customer.lifetimePoints).multiplier;
  await credit(tx, { restaurantId: o.restaurantId, customerId: customer.id, points: Math.floor((spend / 10_000) * cfg.pointsPer100 * mult), reason: 'EARN', orderId, note: `Order #${o.number}` });

  // Referral: only the referred friend's first completed order triggers it, once, and only above the minimum spend.
  const ref = await tx.referral.findUnique({ where: { referredId: customer.id } });
  if (ref && ref.status === 'PENDING' && spend >= cfg.referralMinOrderCents && cfg.referralBonusPoints > 0) {
    const rewarded = await tx.referral.count({ where: { referrerId: ref.referrerId, status: 'REWARDED' } });
    if (rewarded < cfg.referralMaxRewards) {
      const claimed = await tx.referral.updateMany({ where: { id: ref.id, status: 'PENDING' }, data: { status: 'REWARDED', rewardedAt: new Date() } });
      if (claimed.count) {
        await credit(tx, { restaurantId: o.restaurantId, customerId: customer.id, points: cfg.referralBonusPoints, reason: 'REFERRAL', orderId, note: 'Welcome bonus (referred by a friend)' });
        await credit(tx, { restaurantId: o.restaurantId, customerId: ref.referrerId, points: cfg.referralBonusPoints, reason: 'REFERRAL', orderId, note: `Referral bonus (${customer.name} ordered)` });
      }
    }
  }
}

/** Turns points into a single-use voucher bound to the customer's phone number. */
export async function redeemPoints(opts: { restaurantId: string; customerId: string; points: number; actorId: string }) {
  const restaurant = await prisma.restaurant.findUniqueOrThrow({ where: { id: opts.restaurantId } });
  if (!restaurant.loyaltyEnabled) throw new HttpError(409, 'Loyalty is switched off for this outlet', 'loyalty_disabled');
  const cfg = parseLoyaltyConfig(restaurant.loyaltyConfig);
  if (!Number.isInteger(opts.points) || opts.points < cfg.minRedeemPoints)
    throw new HttpError(400, `Redeem at least ${cfg.minRedeemPoints} points`, 'validation', { points: [`Minimum ${cfg.minRedeemPoints}`] });
  if (cfg.pointValueCents <= 0) throw new HttpError(409, 'Points have no cash value configured', 'loyalty_disabled');

  return prisma.$transaction(async (tx) => {
    const customer = await tx.customer.findFirst({ where: { id: opts.customerId, restaurantId: opts.restaurantId } });
    if (!customer) throw new HttpError(404, 'Customer not found', 'not_found');
    // conditional decrement: two concurrent redemptions can never spend the same points twice
    const spent = await tx.customer.updateMany({ where: { id: customer.id, loyaltyPoints: { gte: opts.points } }, data: { loyaltyPoints: { decrement: opts.points } } });
    if (!spent.count) throw new HttpError(409, 'Not enough points', 'insufficient_points');
    const code = `RW-${randomCode(8)}`;
    await tx.coupon.create({
      data: {
        restaurantId: opts.restaurantId, code, type: 'FIXED', value: opts.points * cfg.pointValueCents, usageLimit: 1,
        customerPhone: customer.phone, source: `redeem-${code}`, expiresAt: new Date(Date.now() + 90 * 86_400_000),
      },
    });
    await tx.loyaltyTransaction.create({ data: { restaurantId: opts.restaurantId, customerId: customer.id, delta: -opts.points, reason: 'REDEEM', note: code, actorId: opts.actorId } });
    return { code, valueCents: opts.points * cfg.pointValueCents, pointsSpent: opts.points };
  });
}

/** Issues one birthday voucher per customer per year (idempotent through the coupon's unique source). */
export async function issueBirthdayVouchers(restaurantId: string, now = new Date()) {
  const r = await prisma.restaurant.findUniqueOrThrow({ where: { id: restaurantId } });
  const cfg = parseLoyaltyConfig(r.loyaltyConfig);
  if (!r.loyaltyEnabled || !cfg.birthdayEnabled) return { issued: 0 };
  const local = new Date(now.getTime() + r.utcOffsetMinutes * 60_000);
  const month = local.getUTCMonth() + 1, day = local.getUTCDate(), year = local.getUTCFullYear();
  const people = await prisma.$queryRaw<{ id: string; phone: string }[]>`
    SELECT id, phone FROM "Customer" WHERE "restaurantId" = ${restaurantId} AND birthday IS NOT NULL
    AND EXTRACT(MONTH FROM birthday) = ${month} AND EXTRACT(DAY FROM birthday) = ${day}`;
  let issued = 0;
  for (const p of people) {
    try {
      await prisma.coupon.create({
        data: {
          restaurantId, code: `BD-${randomCode(8)}`, type: cfg.birthdayType, value: cfg.birthdayValue, usageLimit: 1,
          customerPhone: p.phone, source: `birthday-${year}`, expiresAt: new Date(now.getTime() + cfg.birthdayValidDays * 86_400_000),
        },
      });
      issued++;
    } catch (e: any) {
      if (e.code !== 'P2002') throw e; // already issued this year
    }
  }
  return { issued };
}
