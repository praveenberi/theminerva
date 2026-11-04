import { prisma } from './core';
import { parseLoyaltyConfig, tierFor } from './loyalty';

export type Segment = 'NEW' | 'RETURNING' | 'VIP' | 'INACTIVE';
export const SEGMENTS = ['ALL', 'NEW', 'RETURNING', 'VIP', 'INACTIVE', 'BIRTHDAY_MONTH'] as const;

/** Every customer of the outlet with spend, order count, segment and loyalty tier computed from real orders. */
export async function customersWithStats(restaurantId: string, limit = 2000) {
  const r = await prisma.restaurant.findUniqueOrThrow({ where: { id: restaurantId } });
  const cfg = parseLoyaltyConfig(r.loyaltyConfig);
  const customers = await prisma.customer.findMany({
    where: { restaurantId },
    include: { orders: { where: { status: { notIn: ['CANCELLED', 'PENDING_PAYMENT'] } }, select: { totalCents: true, createdAt: true } } },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
  const now = Date.now();
  const thisMonth = new Date(now + r.utcOffsetMinutes * 60_000).getUTCMonth();
  return customers.map((c) => {
    const spentCents = c.orders.reduce((s, o) => s + o.totalCents, 0);
    const last = c.orders.reduce((m, o) => Math.max(m, o.createdAt.getTime()), 0);
    let segment: Segment = c.orders.length >= 5 || spentCents >= 500_000 ? 'VIP' : c.orders.length > 1 ? 'RETURNING' : 'NEW';
    if (last && now - last > 60 * 86_400_000) segment = 'INACTIVE';
    return {
      id: c.id, name: c.name, phone: c.phone, email: c.email, marketingConsent: c.marketingConsent && !c.optedOutAt,
      optedOut: !!c.optedOutAt, loyaltyPoints: c.loyaltyPoints, lifetimePoints: c.lifetimePoints, tier: tierFor(cfg, c.lifetimePoints).name,
      birthday: c.birthday, birthdayThisMonth: !!c.birthday && c.birthday.getUTCMonth() === thisMonth, referralCode: c.referralCode,
      unsubscribeToken: c.unsubscribeToken, orderCount: c.orders.length, spentCents, lastOrderAt: last ? new Date(last) : null, segment,
    };
  });
}

export const inSegment = (c: { segment: Segment; birthdayThisMonth: boolean }, seg: string) =>
  seg === 'ALL' || (seg === 'BIRTHDAY_MONTH' ? c.birthdayThisMonth : c.segment === seg);
