export interface CouponRule {
  type: 'PERCENT' | 'FIXED';
  value: number;
  minSubtotalCents: number;
}

export interface PricingConfig {
  taxPercent: number;
  serviceChargePercent: number;
  deliveryFeeCents: number;
  isDelivery: boolean;
}

export interface Totals {
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  serviceCents: number;
  deliveryCents: number;
  tipCents: number;
  totalCents: number;
}

export function couponDiscount(coupon: CouponRule | null, subtotalCents: number): number {
  if (!coupon || subtotalCents < coupon.minSubtotalCents) return 0;
  const raw = coupon.type === 'PERCENT' ? Math.round((subtotalCents * coupon.value) / 100) : coupon.value;
  return Math.max(0, Math.min(raw, subtotalCents));
}

/** All amounts are integer minor units. Tax and service charge apply to the discounted subtotal. */
export function computeTotals(
  subtotalCents: number,
  cfg: PricingConfig,
  coupon: CouponRule | null,
  tipCents = 0,
): Totals {
  const discountCents = couponDiscount(coupon, subtotalCents);
  const taxable = subtotalCents - discountCents;
  const taxCents = Math.round((taxable * cfg.taxPercent) / 100);
  const serviceCents = Math.round((taxable * cfg.serviceChargePercent) / 100);
  const deliveryCents = cfg.isDelivery ? cfg.deliveryFeeCents : 0;
  const tip = Math.max(0, Math.round(tipCents));
  return {
    subtotalCents,
    discountCents,
    taxCents,
    serviceCents,
    deliveryCents,
    tipCents: tip,
    totalCents: taxable + taxCents + serviceCents + deliveryCents + tip,
  };
}

const NEXT: Record<string, string[]> = {
  NEW: ['ACCEPTED', 'CANCELLED'],
  ACCEPTED: ['PREPARING', 'CANCELLED'],
  PREPARING: ['READY', 'CANCELLED'],
  READY: ['OUT_FOR_DELIVERY', 'SERVED', 'COMPLETED'],
  OUT_FOR_DELIVERY: ['COMPLETED'],
  SERVED: ['COMPLETED'],
  COMPLETED: [],
  CANCELLED: [],
};

export function canTransition(from: string, to: string): boolean {
  return (NEXT[from] ?? []).includes(to);
}
export const nextStatuses = (from: string) => NEXT[from] ?? [];
