import { prisma } from '../db.js';
import { badRequest } from '../lib/http.js';
import { fromCents, pct, toCents } from '../lib/money.js';
import { getSettings } from '../lib/settings.js';
import type { OrderType } from '@prisma/client';

export interface CartInput {
  items: Array<{ productId: string; variantId?: string; addonIds?: string[]; quantity: number; notes?: string }>;
  type: OrderType;
  couponCode?: string;
  voucherCode?: string;
  redeemPoints?: number;
  tip?: number;
  deliveryPostal?: string;
  deliveryZoneId?: string;
  customerId?: string | null;
  outletId?: string | null;
  now?: Date;
}

export interface PricedLine {
  productId: string; name: string; variantName?: string; addons: Array<{ id: string; name: string; price: number }>;
  quantity: number; unitPrice: number; lineTotal: number; notes?: string; prepMinutes: number; categoryId: string;
}
export interface Priced {
  lines: PricedLine[]; subtotal: number; discount: number; serviceCharge: number; tax: number;
  deliveryFee: number; tip: number; total: number; prepMinutes: number;
  couponId?: string; voucherId?: string; pointsRedeemed: number; deliveryZoneId?: string; messages: string[];
}

/** minutes since midnight in the restaurant timezone */
export function localParts(d: Date, tz: string) {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short' });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  const hh = Number(p.hour) % 24;
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return { minutes: hh * 60 + Number(p.minute), day: days.indexOf(p.weekday as string) };
}
const toMin = (s?: string | null) => (s ? Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5)) : null);

export function inWindow(minutes: number, from?: string | null, to?: string | null) {
  const a = toMin(from), b = toMin(to);
  if (a === null || b === null) return true;
  return a <= b ? minutes >= a && minutes < b : minutes >= a || minutes < b; // overnight windows
}

export async function priceCart(input: CartInput): Promise<Priced> {
  const s = await getSettings();
  const restaurant = await prisma.restaurant.findUnique({ where: { id: 'minerva' } });
  const tz = restaurant?.timezone ?? 'Asia/Singapore';
  const now = input.now ?? new Date();
  const local = localParts(now, tz);
  const messages: string[] = [];

  if (!input.items.length) throw badRequest('Your cart is empty');
  if (input.type === 'DELIVERY' && !s.ordering.deliveryEnabled) throw badRequest('Delivery is currently unavailable');
  if ((input.type === 'TAKEAWAY' || input.type === 'PICKUP') && !s.ordering.takeawayEnabled) throw badRequest('Takeaway is currently unavailable');
  if (input.type === 'DINE_IN' && !s.ordering.dineInEnabled) throw badRequest('Dine-in ordering is currently unavailable');

  const products = await prisma.product.findMany({
    where: { id: { in: input.items.map((i) => i.productId) } },
    include: { variants: true, addonGroups: { include: { addons: true } }, category: { include: { menu: true } } },
  });
  const rules = await prisma.pricingRule.findMany({ where: { isActive: true } });
  const overrides = input.outletId ? await prisma.outletProduct.findMany({ where: { outletId: input.outletId, productId: { in: products.map((x) => x.id) } } }) : [];

  const lines: PricedLine[] = [];
  for (const it of input.items) {
    if (!Number.isInteger(it.quantity) || it.quantity < 1 || it.quantity > 50) throw badRequest('Invalid quantity');
    const p = products.find((x) => x.id === it.productId);
    if (!p || !p.isPublished) throw badRequest('An item in your cart is no longer on the menu');
    if (!p.isAvailable || !p.category.isActive || !p.category.menu.isActive) throw badRequest(`${p.name} is currently unavailable`);
    if (!inWindow(local.minutes, p.availableFrom, p.availableTo) || !inWindow(local.minutes, p.category.menu.availableFrom, p.category.menu.availableTo))
      throw badRequest(`${p.name} is not available at this time`);

    const ov = overrides.find((o) => o.productId === p.id);
    if (ov && !ov.isAvailable) throw badRequest(`${p.name} is not available at this branch`);
    let unit = ov?.price != null ? toCents(ov.price) : toCents(p.discountPrice ?? p.price);
    // dynamic pricing rule (best percentage that applies)
    const applicable = rules.filter((r) => (!r.categoryId || r.categoryId === p.categoryId) && inWindow(local.minutes, r.startTime, r.endTime) && (!r.days.length || r.days.includes(local.day)));
    if (applicable.length) {
      const best = Math.max(...applicable.map((r) => Number(r.percentOff)));
      unit = Math.min(unit, toCents(ov?.price ?? p.price) - pct(toCents(ov?.price ?? p.price), best));
    }
    let variantName: string | undefined;
    if (it.variantId) {
      const v = p.variants.find((x) => x.id === it.variantId);
      if (!v) throw badRequest(`Invalid size selected for ${p.name}`);
      unit += toCents(v.priceDelta);
      variantName = v.name;
    } else if (p.variants.length) throw badRequest(`Please choose a size for ${p.name}`);

    const addons: PricedLine['addons'] = [];
    const chosen = new Set(it.addonIds ?? []);
    for (const g of p.addonGroups) {
      const n = g.addons.filter((a) => chosen.has(a.id));
      if (n.length < g.minSelect) throw badRequest(`Choose at least ${g.minSelect} option(s) for "${g.name}" on ${p.name}`);
      if (n.length > g.maxSelect) throw badRequest(`Choose at most ${g.maxSelect} option(s) for "${g.name}" on ${p.name}`);
      for (const a of n) { unit += toCents(a.price); addons.push({ id: a.id, name: a.name, price: Number(a.price) }); chosen.delete(a.id); }
    }
    if (chosen.size) throw badRequest(`Invalid add-on for ${p.name}`);

    lines.push({
      productId: p.id, name: p.name, variantName, addons, quantity: it.quantity, unitPrice: fromCents(unit),
      lineTotal: fromCents(unit * it.quantity), notes: it.notes?.slice(0, 300), prepMinutes: p.prepMinutes, categoryId: p.categoryId,
    });
  }

  const subtotal = lines.reduce((a, l) => a + toCents(l.lineTotal), 0);
  let discount = 0;
  let couponId: string | undefined;
  let voucherId: string | undefined;
  let pointsRedeemed = 0;

  if (input.couponCode) {
    const c = await prisma.coupon.findUnique({ where: { code: input.couponCode.trim().toUpperCase() } });
    if (!c || !c.isActive) throw badRequest('This promo code is not valid');
    if (c.startsAt && c.startsAt > now) throw badRequest('This promo code is not active yet');
    if (c.endsAt && c.endsAt < now) throw badRequest('This promo code has expired');
    if (c.maxUses !== null && c.usedCount >= c.maxUses) throw badRequest('This promo code has been fully redeemed');
    if (c.customerId && c.customerId !== input.customerId) throw badRequest('This promo code is reserved for another customer');
    if (!inWindow(local.minutes, c.startTime, c.endTime)) throw badRequest(`This promo is only valid ${c.startTime}–${c.endTime}`);
    const eligible = c.categoryId ? lines.filter((l) => l.categoryId === c.categoryId) : lines;
    const eligibleCents = eligible.reduce((a, l) => a + toCents(l.lineTotal), 0);
    if (!eligibleCents) throw badRequest('This promo code does not apply to the items in your cart');
    if (subtotal < toCents(c.minSubtotal)) throw badRequest(`Spend at least ${Number(c.minSubtotal).toFixed(2)} to use this code`);
    if (c.type === 'PERCENT') discount += pct(eligibleCents, Number(c.value));
    else if (c.type === 'FIXED') discount += Math.min(toCents(c.value), eligibleCents);
    else {
      // BOGO: cheapest unit in each eligible line pair is free
      for (const l of eligible) discount += Math.floor(l.quantity / 2) * toCents(l.unitPrice);
    }
    couponId = c.id;
  }
  discount = Math.min(discount, subtotal);

  if (input.voucherCode) {
    if (!input.customerId) throw badRequest('Sign in to use a reward voucher');
    const v = await prisma.voucher.findUnique({ where: { code: input.voucherCode.trim().toUpperCase() } });
    if (!v || v.customerId !== input.customerId || v.usedAt || (v.expiresAt && v.expiresAt < now)) throw badRequest('This voucher is not valid');
    const apply = Math.min(toCents(v.amount), subtotal - discount);
    discount += apply; voucherId = v.id;
  }

  if (input.redeemPoints && input.redeemPoints > 0) {
    if (!input.customerId) throw badRequest('Sign in to redeem points');
    if (!s.loyalty.enabled) throw badRequest('Loyalty is not enabled');
    if (input.redeemPoints < s.loyalty.minRedeemPoints) throw badRequest(`Minimum redemption is ${s.loyalty.minRedeemPoints} points`);
    const cust = await prisma.customer.findUnique({ where: { id: input.customerId } });
    if (!cust || cust.loyaltyPoints < input.redeemPoints) throw badRequest('Not enough loyalty points');
    const worth = Math.min(toCents(input.redeemPoints * s.loyalty.pointValue), subtotal - discount);
    // only burn points that are actually used
    pointsRedeemed = Math.ceil(worth / toCents(s.loyalty.pointValue));
    discount += worth;
  }

  const net = subtotal - discount;
  const serviceCharge = input.type === 'DINE_IN' ? pct(net, s.ordering.serviceChargePct) : 0;
  let tax = 0;
  if (s.ordering.taxRate > 0) {
    tax = s.ordering.taxInclusive
      ? Math.round((net + serviceCharge) - (net + serviceCharge) / (1 + s.ordering.taxRate / 100))
      : pct(net + serviceCharge, s.ordering.taxRate);
  }

  let deliveryFee = 0;
  let deliveryZoneId: string | undefined;
  if (input.type === 'DELIVERY') {
    const zones = await prisma.deliveryZone.findMany({ where: { isActive: true } });
    const postal = (input.deliveryPostal ?? '').replace(/\s/g, '');
    const zone = input.deliveryZoneId
      ? zones.find((z) => z.id === input.deliveryZoneId)
      : zones.find((z) => z.postalPrefixes.some((p) => postal.startsWith(p)));
    if (!zone) throw badRequest('Sorry, we do not deliver to that address');
    if (net < toCents(zone.minOrder)) throw badRequest(`Minimum order for ${zone.name} delivery is ${Number(zone.minOrder).toFixed(2)}`);
    deliveryFee = toCents(zone.fee);
    deliveryZoneId = zone.id;
  }
  if (s.ordering.minOrder > 0 && subtotal < toCents(s.ordering.minOrder)) throw badRequest(`Minimum order is ${s.ordering.minOrder.toFixed(2)}`);

  const tip = Math.max(0, toCents(input.tip ?? 0));
  const taxExtra = s.ordering.taxInclusive ? 0 : tax;
  const total = net + serviceCharge + taxExtra + deliveryFee + tip;
  const prepMinutes = Math.max(...lines.map((l) => l.prepMinutes)) + Math.min(20, Math.floor(lines.reduce((a, l) => a + l.quantity, 0) / 4) * 2);

  return {
    lines, subtotal: fromCents(subtotal), discount: fromCents(discount), serviceCharge: fromCents(serviceCharge),
    tax: fromCents(tax), deliveryFee: fromCents(deliveryFee), tip: fromCents(tip), total: fromCents(total),
    prepMinutes, couponId, voucherId, pointsRedeemed, deliveryZoneId, messages,
  };
}
