import { Router } from 'express';
import crypto from 'node:crypto';
import rateLimit from 'express-rate-limit';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { HttpError, parse, prisma } from '../lib/core';
import { computeTotals, type CouponRule } from '../lib/pricing';
import { inWindow, promoDiscount, type PromoLine } from '../lib/promo';
import { ensureReferralCode, parseLoyaltyConfig, tierFor } from '../lib/loyalty';
import { getEntitlements, type Entitlements } from '../lib/billing';
import { checkoutAdapter, hasActiveAccount } from '../lib/paymentAccounts';
import { wrap } from '../middleware/auth';
import { activeAdapter } from '../lib/payments';
import { startCheckout } from '../lib/paymentService';

export const pub = Router();
const writeLimiter = rateLimit({ windowMs: 60_000, limit: Number(process.env.PUBLIC_WRITE_LIMIT ?? 30), standardHeaders: true, legacyHeaders: false });

/** Storefront visitors can always browse, but orders and bookings need an active subscription. */
async function takingOrders(r: { tenantId: string }) {
  const e = await getEntitlements(r.tenantId);
  if (!e.operational) throw new HttpError(503, 'This restaurant is not taking orders right now. Please contact them directly.', 'unavailable');
  return e;
}

async function getPublished(slug: string) {
  const r = await prisma.restaurant.findUnique({ where: { slug } });
  if (!r || !r.published) throw new HttpError(404, 'Restaurant not found', 'not_found');
  return r;
}

const publicInfo = (r: Awaited<ReturnType<typeof getPublished>>, e: Entitlements, hasAccount: boolean) => ({
  slug: r.slug, name: r.name, description: r.description, category: r.category, address: r.address,
  phone: r.phone, whatsapp: r.whatsapp, currency: r.currency, orderTypes: r.orderTypes,
  taxPercent: Number(r.taxPercent), serviceChargePercent: Number(r.serviceChargePercent),
  deliveryFeeCents: r.deliveryFeeCents, minDeliveryCents: r.minDeliveryCents,
  openTime: r.openTime, closeTime: r.closeTime, reservationSlotMinutes: r.reservationSlotMinutes,
  onlinePayments: r.onlinePayments && hasAccount && e.features.has('online_payments'),
  acceptingOrders: e.operational,
  reservations: e.operational && e.features.has('reservations'),
  bannerText: r.bannerText,
  loyalty: r.loyaltyEnabled && e.features.has('loyalty') ? { referralBonusPoints: parseLoyaltyConfig(r.loyaltyConfig).referralBonusPoints } : null,
});

const page = (title: string, body: string) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><body style="font-family:system-ui,sans-serif;max-width:28rem;margin:4rem auto;padding:0 1rem;text-align:center"><h1>${title}</h1><p>${body}</p></body>`;

/**
 * One-click opt-out from marketing, linked from every campaign message. Applies to every outlet of the brand that
 * holds this phone number, so a customer who opts out of one branch is not messaged by another.
 */
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// Mail security scanners and link previews open every link in a message, so a GET must never opt anyone out by itself.
pub.get('/unsubscribe/:token', wrap(async (req, res) => {
  const c = await prisma.customer.findUnique({ where: { unsubscribeToken: req.params.token }, include: { restaurant: true } });
  if (!c) return void res.status(404).type('html').send(page('Link not found', 'This unsubscribe link is not valid.'));
  res.type('html').send(page('Unsubscribe?', `Stop promotional messages from ${esc(c.restaurant.name)}?<form method="post" style="margin-top:1.5rem"><button style="padding:.75rem 1.5rem;font-size:1rem;cursor:pointer">Yes, unsubscribe me</button></form>`));
}));

pub.post('/unsubscribe/:token', wrap(async (req, res) => {
  const c = await prisma.customer.findUnique({ where: { unsubscribeToken: req.params.token }, include: { restaurant: true } });
  if (!c) return void res.status(404).type('html').send(page('Link not found', 'This unsubscribe link is not valid.'));
  const siblings = await prisma.restaurant.findMany({ where: { tenantId: c.restaurant.tenantId }, select: { id: true } });
  await prisma.customer.updateMany({ where: { phone: c.phone, restaurantId: { in: siblings.map((x) => x.id) } }, data: { marketingConsent: false, optedOutAt: new Date() } });
  res.type('html').send(page('You are unsubscribed', `You will no longer receive promotional messages from ${esc(c.restaurant.name)}. Order updates are not affected.`));
}));

pub.get('/orders/track/:code', wrap(async (req, res) => {
  const o = await prisma.order.findUnique({
    where: { trackingCode: req.params.code },
    include: { items: true, table: { select: { label: true } }, history: { orderBy: { createdAt: 'asc' } }, restaurant: { select: { slug: true, name: true, currency: true, tenantId: true, loyaltyEnabled: true, loyaltyConfig: true } }, payments: { where: { status: 'PENDING' }, take: 1 }, deliveryPartner: { select: { name: true, phone: true } } },
  });
  if (!o) throw new HttpError(404, 'Order not found', 'not_found');
  let rewards: object | null = null;
  if (o.customerId && o.restaurant.loyaltyEnabled && (await getEntitlements(o.restaurant.tenantId)).features.has('loyalty')) {
    const [referralCode, customer, vouchers] = await Promise.all([
      ensureReferralCode(o.customerId),
      prisma.customer.findUniqueOrThrow({ where: { id: o.customerId } }),
      prisma.coupon.findMany({
        where: { restaurantId: o.restaurantId, customerPhone: o.customerPhone, active: true, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
        orderBy: { expiresAt: 'asc' },
      }),
    ]);
    const cfg = parseLoyaltyConfig(o.restaurant.loyaltyConfig);
    rewards = {
      referralCode, referralBonusPoints: cfg.referralBonusPoints, points: customer.loyaltyPoints, tier: tierFor(cfg, customer.lifetimePoints).name,
      vouchers: vouchers.filter((v) => v.usageLimit == null || v.usedCount < v.usageLimit).map((v) => ({ code: v.code, type: v.type, value: v.value, expiresAt: v.expiresAt })),
    };
  }
  res.json({
    rewards,
    payUrl: o.status === 'PENDING_PAYMENT' ? o.payments[0]?.checkoutUrl ?? null : null,
    etaAt: o.etaMinutes ? new Date(o.createdAt.getTime() + o.etaMinutes * 60_000) : null,
    // the rider's contact is only shared once the order is on its way
    rider: o.status === 'OUT_FOR_DELIVERY' && o.deliveryPartner ? o.deliveryPartner : null,
    number: o.number, status: o.status, type: o.type, table: o.table?.label ?? null, restaurant: o.restaurant, totalCents: o.totalCents,
    paymentMethod: o.paymentMethod, paymentStatus: o.paymentStatus, createdAt: o.createdAt,
    items: o.items.map((i) => ({ name: i.name, quantity: i.quantity, unitPriceCents: i.unitPriceCents })),
    history: o.history.map((h) => ({ status: h.status, at: h.createdAt })),
  });
}));

// Menu photos. The id is unguessable and the bytes never change, so browsers and CDNs may keep them for a year.
pub.get('/images/:id', wrap(async (req, res) => {
  const img = await prisma.menuImage.findUnique({ where: { id: req.params.id } });
  if (!img) throw new HttpError(404, 'Not found', 'not_found');
  res.set({
    'Content-Type': img.contentType, 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox", 'Cross-Origin-Resource-Policy': 'cross-origin',
  });
  res.send(Buffer.from(img.data));
}));

pub.get('/:slug', wrap(async (req, res) => {
  const r = await getPublished(req.params.slug);
  const categories = await prisma.category.findMany({
    where: { restaurantId: r.id },
    orderBy: { sort: 'asc' },
    include: { products: { orderBy: [{ sort: 'asc' }, { createdAt: 'asc' }] } },
  });
  const zones = await prisma.deliveryZone.findMany({ where: { restaurantId: r.id, active: true }, orderBy: { feeCents: 'asc' }, select: { id: true, name: true, feeCents: true, minOrderCents: true, etaMinutes: true } });
  res.json({
    restaurant: { ...publicInfo(r, await getEntitlements(r.tenantId), await hasActiveAccount(r.id)), deliveryZones: zones },
    categories: categories
      .filter((c) => c.products.length)
      .map((c) => ({
        id: c.id, name: c.name,
        products: c.products.map((p) => ({
          id: p.id, name: p.name, description: p.description, priceCents: p.priceCents,
          discountPriceCents: p.discountPriceCents, imageUrl: p.imageUrl, available: p.available,
          dietary: p.dietary, allergens: p.allergens, prepMinutes: p.prepMinutes, variants: p.variants, addons: p.addons,
        })),
      })),
  });
}));

type CartItem = { productId: string; quantity: number; variantId?: string; addonIds: string[]; notes?: string };
const cartItemSchema = z.object({
  productId: z.string(),
  quantity: z.number().int().min(1).max(50),
  variantId: z.string().optional(),
  addonIds: z.array(z.string()).max(30).default([]),
  notes: z.string().max(200).optional(),
});
type Opt = { id: string; name: string; priceCents: number };

/** Prices a cart from the database. Client-supplied prices are never read. */
async function priceCart(restaurantId: string, items: CartItem[]) {
  const products = await prisma.product.findMany({ where: { restaurantId, id: { in: items.map((i) => i.productId) } } });
  const byId = new Map(products.map((p) => [p.id, p]));
  let subtotal = 0;
  const lines = items.map((i) => {
    const p = byId.get(i.productId);
    if (!p) throw new HttpError(400, 'An item in your cart no longer exists', 'item_missing');
    if (!p.available) throw new HttpError(409, `${p.name} is currently unavailable`, 'item_unavailable');
    const variants = p.variants as unknown as Opt[]; const addons = p.addons as unknown as Opt[];
    const variant = i.variantId ? variants.find((v) => v.id === i.variantId) : undefined;
    if (i.variantId && !variant) throw new HttpError(400, `Invalid size for ${p.name}`, 'validation');
    if (!variant && variants.length) throw new HttpError(400, `Please choose a size for ${p.name}`, 'validation');
    const chosen = i.addonIds.map((id) => {
      const a = addons.find((x) => x.id === id);
      if (!a) throw new HttpError(400, `Invalid add-on for ${p.name}`, 'validation');
      return a;
    });
    const unit = (p.discountPriceCents ?? p.priceCents) + (variant?.priceCents ?? 0) + chosen.reduce((sum, a) => sum + a.priceCents, 0);
    subtotal += unit * i.quantity;
    return {
      productId: p.id, name: p.name, unitPriceCents: unit, quantity: i.quantity, notes: i.notes ?? null,
      options: [...(variant ? [variant.name] : []), ...chosen.map((a) => a.name)],
    };
  });
  const promoLines: PromoLine[] = items.map((i, k) => ({ categoryId: byId.get(i.productId)!.categoryId, unitCents: lines[k].unitPriceCents, quantity: i.quantity }));
  return { subtotal, lines, promoLines };
}

const digits = (s: string) => s.replace(/\D/g, '');

async function findCoupon(r: { id: string; utcOffsetMinutes: number }, code: string, promoLines: PromoLine[], phone?: string) {
  const c = await prisma.coupon.findUnique({ where: { restaurantId_code: { restaurantId: r.id, code: code.toUpperCase() } } });
  if (!c || !c.active) throw new HttpError(400, 'Invalid coupon code', 'coupon_invalid');
  if (c.expiresAt && c.expiresAt < new Date()) throw new HttpError(400, 'This coupon has expired', 'coupon_invalid');
  if (c.usageLimit != null && c.usedCount >= c.usageLimit) throw new HttpError(400, 'This coupon is fully redeemed', 'coupon_invalid');
  // vouchers issued to one customer only work with that customer's phone number
  if (c.customerPhone && (!phone || digits(phone) !== digits(c.customerPhone))) throw new HttpError(400, 'This code is not valid for this phone number', 'coupon_invalid');
  if (!inWindow(c, new Date(), r.utcOffsetMinutes)) throw new HttpError(400, 'This offer is not available at this time', 'coupon_window');
  const subtotal = promoLines.reduce((sum, l) => sum + l.unitCents * l.quantity, 0);
  if (subtotal < c.minSubtotalCents) throw new HttpError(400, 'Order total is below the coupon minimum', 'coupon_min', { minSubtotalCents: c.minSubtotalCents });
  const discountCents = promoDiscount(c, promoLines);
  if (discountCents <= 0) throw new HttpError(400, 'This offer does not apply to the items in your cart', 'coupon_not_applicable');
  return { coupon: c, discountCents };
}

pub.post('/:slug/coupon', writeLimiter, wrap(async (req, res) => {
  const r = await getPublished(req.params.slug);
  const d = parse(z.object({ code: z.string().min(1).max(20), phone: z.string().max(30).optional(), items: z.array(cartItemSchema).min(1).max(60) }), req.body);
  if (!(await takingOrders(r)).features.has('promotions')) throw new HttpError(400, 'Offers are not available at this restaurant', 'coupon_invalid');
  const { promoLines } = await priceCart(r.id, d.items);
  const { coupon, discountCents } = await findCoupon(r, d.code, promoLines, d.phone);
  res.json({ code: coupon.code, type: coupon.type, discountCents });
}));

// ---------- order placement ----------
const orderSchema = z.object({
  type: z.enum(['DINE_IN', 'TAKEAWAY', 'DELIVERY']),
  customerName: z.string().trim().min(2).max(80),
  customerPhone: z.string().trim().regex(/^[+\d][\d\s-]{6,18}$/, 'Enter a valid phone number'),
  email: z.string().email().optional().or(z.literal('')),
  marketingConsent: z.boolean().default(false),
  referralCode: z.string().trim().toUpperCase().max(12).optional().or(z.literal('')),
  birthday: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal('')),
  tableLabel: z.string().max(20).optional(),
  address: z.string().max(300).optional(),
  zoneId: z.string().optional(),
  notes: z.string().max(300).optional(),
  couponCode: z.string().max(20).optional().or(z.literal('')),
  tipCents: z.number().int().min(0).max(1_000_000).default(0),
  paymentMethod: z.enum(['CASH', 'ONLINE']).default('CASH'),
  items: z.array(cartItemSchema).min(1).max(60),
});


pub.post('/:slug/orders', writeLimiter, wrap(async (req, res) => {
  const r = await getPublished(req.params.slug);
  const d = parse(orderSchema, req.body);
  if (!r.orderTypes.includes(d.type)) throw new HttpError(400, 'This order type is not offered', 'order_type');
  const ent = await takingOrders(r);
  const acct = d.paymentMethod === 'ONLINE' ? await checkoutAdapter(r.id) : null;
  if (d.couponCode && !ent.features.has('promotions')) throw new HttpError(400, 'Offers are not available at this restaurant', 'coupon_invalid');
  const loyaltyOn = r.loyaltyEnabled && ent.features.has('loyalty');
  if (d.paymentMethod === 'ONLINE' && !(r.onlinePayments && acct && ent.features.has('online_payments')))
    throw new HttpError(400, 'Online payment is not available for this restaurant', 'payment_unavailable');

  let tableId: string | null = null;
  if (d.type === 'DINE_IN') {
    const t = d.tableLabel && await prisma.diningTable.findUnique({ where: { restaurantId_label: { restaurantId: r.id, label: d.tableLabel } } });
    if (!t) throw new HttpError(400, 'Please choose a valid table', 'validation', { tableLabel: ['Unknown table'] });
    tableId = t.id;
  }
  if (d.type === 'DELIVERY' && !d.address?.trim()) throw new HttpError(400, 'Delivery address is required', 'validation', { address: ['Required'] });

  // Delivery pricing: if the restaurant defines zones the customer must pick one and its fee/minimum/ETA apply;
  // otherwise the restaurant-wide flat fee and minimum are used.
  let delivery = { zoneId: null as string | null, feeCents: r.deliveryFeeCents, minCents: r.minDeliveryCents, etaMinutes: null as number | null };
  if (d.type === 'DELIVERY') {
    const zones = await prisma.deliveryZone.findMany({ where: { restaurantId: r.id, active: true } });
    if (zones.length) {
      const z = zones.find((x) => x.id === d.zoneId);
      if (!z) throw new HttpError(400, 'Please choose your delivery area', 'validation', { zoneId: ['Choose a delivery area'] });
      delivery = { zoneId: z.id, feeCents: z.feeCents, minCents: z.minOrderCents, etaMinutes: z.etaMinutes };
    }
  }

  const { subtotal, lines, promoLines } = await priceCart(r.id, d.items);
  if (d.type === 'DELIVERY' && subtotal < delivery.minCents)
    throw new HttpError(400, 'Order is below the delivery minimum', 'delivery_min', { minDeliveryCents: delivery.minCents });

  let birthday: Date | null = null;
  if (d.birthday) {
    birthday = new Date(`${d.birthday}T00:00:00Z`);
    if (Number.isNaN(birthday.getTime()) || birthday > new Date() || birthday.getUTCFullYear() < 1900)
      throw new HttpError(400, 'Enter a valid birthday', 'validation', { birthday: ['Enter a valid birthday'] });
  }

  const applied = d.couponCode ? await findCoupon(r, d.couponCode, promoLines, d.customerPhone) : null;
  const coupon = applied?.coupon ?? null;
  // the discount is already worked out per line (category, BOGO…), so totals just apply it as a fixed amount
  const rule: CouponRule | null = applied && { type: 'FIXED', value: applied.discountCents, minSubtotalCents: 0 };
  const totals = computeTotals(subtotal, {
    taxPercent: Number(r.taxPercent), serviceChargePercent: Number(r.serviceChargePercent),
    deliveryFeeCents: delivery.feeCents, isDelivery: d.type === 'DELIVERY',
  }, rule, d.tipCents);

  const { order, referral, merged } = await prisma.$transaction(async (tx) => {
    if (coupon) {
      // atomic redemption: fails if the limit was reached by a concurrent order
      const ok = await tx.$executeRaw`UPDATE "Coupon" SET "usedCount" = "usedCount" + 1 WHERE id = ${coupon.id} AND ("usageLimit" IS NULL OR "usedCount" < "usageLimit")`;
      if (!ok) throw new HttpError(400, 'This coupon is fully redeemed', 'coupon_invalid');
    }
    const existing = await tx.customer.findUnique({ where: { restaurantId_phone: { restaurantId: r.id, phone: d.customerPhone } } });
    const customer = existing
      ? await tx.customer.update({
          where: { id: existing.id },
          data: {
            name: d.customerName, ...(d.email ? { email: d.email } : {}),
            ...(birthday && !existing.birthday ? { birthday } : {}),
            // an explicit new opt-in at checkout overrides an earlier opt-out
            ...(d.marketingConsent ? { marketingConsent: true, optedOutAt: null } : {}),
          },
        })
      : await tx.customer.create({
          data: {
            restaurantId: r.id, phone: d.customerPhone, name: d.customerName, email: d.email || null, marketingConsent: d.marketingConsent,
            birthday, unsubscribeToken: crypto.randomBytes(24).toString('hex'),
          },
        });

    // Referral: only a brand-new customer can be referred, never by themselves, and only once (referredId is unique).
    let referral: 'applied' | 'ignored' | undefined;
    if (d.referralCode) {
      referral = 'ignored';
      if (!existing && loyaltyOn) {
        const referrer = await tx.customer.findFirst({ where: { restaurantId: r.id, referralCode: d.referralCode } });
        if (referrer && digits(referrer.phone) !== digits(customer.phone)) {
          await tx.referral.create({ data: { restaurantId: r.id, referrerId: referrer.id, referredId: customer.id } });
          referral = 'applied';
        }
      }
    }

    // More food for a table that already has an unpaid cash order in progress goes onto that order (one bill per table visit)
    // instead of opening a new one. Paid, online, finished and cancelled orders are never reopened.
    if (tableId && d.paymentMethod === 'CASH') {
      await tx.$queryRaw`SELECT id FROM "DiningTable" WHERE id = ${tableId} FOR UPDATE`; // one writer per table, so two phones ordering at once end up on the same bill
      const [open] = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Order" WHERE "restaurantId" = ${r.id} AND "tableId" = ${tableId} AND type::text = 'DINE_IN'
        AND "paymentMethod" = 'CASH' AND "paymentStatus"::text = 'UNPAID' AND status::text IN ('NEW', 'ACCEPTED', 'PREPARING', 'READY', 'SERVED') ORDER BY "createdAt" DESC LIMIT 1 FOR UPDATE`;
      if (open) {
        const cur = await tx.order.findUniqueOrThrow({ where: { id: open.id } });
        // the same dish (same size, add-ons and note) joins its existing bill line instead of repeating; the extra portions still need cooking
        const have = await tx.orderItem.findMany({ where: { orderId: cur.id } });
        const fresh: typeof lines = [];
        for (const l of lines) {
          const same = l.productId ? have.find((h) => h.productId === l.productId && h.unitPriceCents === l.unitPriceCents && (h.notes ?? '') === (l.notes ?? '') && JSON.stringify(h.options) === JSON.stringify(l.options)) : undefined;
          if (same) {
            same.quantity += l.quantity;
            await tx.orderItem.update({ where: { id: same.id }, data: { quantity: { increment: l.quantity }, prepDone: false } });
          } else fresh.push(l);
        }
        if (fresh.length) await tx.orderItem.createMany({ data: fresh.map((l) => ({ ...l, orderId: cur.id, options: l.options as Prisma.InputJsonValue })) });
        const t = computeTotals(cur.subtotalCents + subtotal, {
          taxPercent: Number(r.taxPercent), serviceChargePercent: Number(r.serviceChargePercent), deliveryFeeCents: 0, isDelivery: false,
        }, { type: 'FIXED', value: cur.discountCents + (applied?.discountCents ?? 0), minSubtotalCents: 0 }, cur.tipCents + d.tipCents);
        // anything beyond NEW goes back to NEW, so the kitchen sees the order again, accepts the addition and cooks it
        const reopen = cur.status !== 'NEW';
        const updated = await tx.order.update({
          where: { id: cur.id },
          data: { ...t, couponCode: cur.couponCode ?? coupon?.code ?? null, notes: d.notes ? [cur.notes, d.notes].filter(Boolean).join(' · ') : cur.notes, ...(reopen ? { status: 'NEW' } : {}) },
        });
        if (reopen) await tx.orderStatusHistory.create({ data: { orderId: cur.id, status: 'NEW' } });
        return { order: updated, referral, merged: true };
      }
    }

    const { orderCounter } = await tx.restaurant.update({ where: { id: r.id }, data: { orderCounter: { increment: 1 } }, select: { orderCounter: true } });
    const order = await tx.order.create({
      data: {
        restaurantId: r.id, number: orderCounter, trackingCode: crypto.randomBytes(9).toString('base64url'),
        type: d.type, customerId: customer.id, customerName: d.customerName, customerPhone: d.customerPhone,
        tableId, address: d.address ?? null, deliveryZoneId: delivery.zoneId, etaMinutes: delivery.etaMinutes, notes: d.notes ?? null, couponCode: coupon?.code ?? null,
        paymentMethod: d.paymentMethod, ...totals,
        // online orders stay invisible to the kitchen until the provider confirms payment
        status: d.paymentMethod === 'ONLINE' ? 'PENDING_PAYMENT' : 'NEW',
        items: { create: lines.map((l) => ({ ...l, options: l.options as Prisma.InputJsonValue })) },
        history: { create: { status: d.paymentMethod === 'ONLINE' ? 'PENDING_PAYMENT' : 'NEW' } },
      },
    });
    return { order, referral, merged: false };
  });
  let payUrl: string | undefined;
  if (d.paymentMethod === 'ONLINE') {
    try {
      payUrl = (await startCheckout(order.id, acct!.adapter, acct!.accountId)).checkoutUrl ?? undefined;
    } catch (e) {
      // no checkout means no payable order: cancel it and give the coupon back
      await prisma.$transaction(async (tx) => {
        await tx.order.update({ where: { id: order.id }, data: { status: 'CANCELLED' } });
        await tx.orderStatusHistory.create({ data: { orderId: order.id, status: 'CANCELLED' } });
        if (coupon) await tx.coupon.update({ where: { id: coupon.id }, data: { usedCount: { decrement: 1 } } });
      });
      throw e instanceof HttpError ? e : new HttpError(502, 'Could not start payment', 'provider_error');
    }
  }
  res.status(201).json({ trackingCode: order.trackingCode, number: order.number, totalCents: order.totalCents, discountCents: order.discountCents, referral, payUrl, merged });
}));

// ---------- reservations ----------
const dayStart = (date: string, tzOffsetMin: number) => new Date(Date.parse(`${date}T00:00:00Z`) + tzOffsetMin * 60_000);
const hhmm = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));

async function freeTables(restaurantId: string, partySize: number, start: Date, end: Date, db: Prisma.TransactionClient | typeof prisma = prisma) {
  const tables = await db.diningTable.findMany({ where: { restaurantId, capacity: { gte: partySize } }, orderBy: { capacity: 'asc' } });
  const busy = await db.reservation.findMany({
    where: { restaurantId, status: 'CONFIRMED', startsAt: { lt: end }, endsAt: { gt: start }, tableId: { in: tables.map((t) => t.id) } },
    select: { tableId: true },
  });
  const taken = new Set(busy.map((b) => b.tableId));
  return tables.filter((t) => !taken.has(t.id));
}

pub.get('/:slug/availability', wrap(async (req, res) => {
  const r = await getPublished(req.params.slug);
  if (!(await takingOrders(r)).features.has('reservations')) throw new HttpError(404, 'Reservations are not available', 'not_found');
  const q = parse(z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    partySize: z.coerce.number().int().min(1).max(50),
    tzOffset: z.coerce.number().int().min(-840).max(840).default(0),
  }), req.query);
  const base = dayStart(q.date, q.tzOffset).getTime();
  const slots: { startsAt: string; available: boolean }[] = [];
  const last = hhmm(r.closeTime) - r.reservationSlotMinutes;
  for (let m = hhmm(r.openTime); m <= last; m += 30) {
    const start = new Date(base + m * 60_000);
    const free = start > new Date() ? await freeTables(r.id, q.partySize, start, new Date(start.getTime() + r.reservationSlotMinutes * 60_000)) : [];
    slots.push({ startsAt: start.toISOString(), available: free.length > 0 });
  }
  res.json({ slots });
}));

pub.post('/:slug/reservations', writeLimiter, wrap(async (req, res) => {
  const r = await getPublished(req.params.slug);
  if (!(await takingOrders(r)).features.has('reservations')) throw new HttpError(404, 'Reservations are not available', 'not_found');
  const d = parse(z.object({
    name: z.string().trim().min(2).max(80),
    phone: z.string().trim().regex(/^[+\d][\d\s-]{6,18}$/, 'Enter a valid phone number'),
    partySize: z.number().int().min(1).max(50),
    startsAt: z.string().datetime(),
    notes: z.string().max(300).optional(),
  }), req.body);
  const start = new Date(d.startsAt);
  if (start <= new Date()) throw new HttpError(400, 'Choose a time in the future', 'validation', { startsAt: ['Must be in the future'] });
  const end = new Date(start.getTime() + r.reservationSlotMinutes * 60_000);

  const created = await prisma.$transaction(async (tx) => {
    // Serialise concurrent bookings for this restaurant by locking its table rows.
    await tx.$queryRaw`SELECT id FROM "DiningTable" WHERE "restaurantId" = ${r.id} FOR UPDATE`;
    const free = await freeTables(r.id, d.partySize, start, end, tx);
    if (!free.length) throw new HttpError(409, 'No table is free at that time', 'no_availability');
    return tx.reservation.create({
      data: { restaurantId: r.id, tableId: free[0].id, name: d.name, phone: d.phone, partySize: d.partySize, startsAt: start, endsAt: end, notes: d.notes ?? null },
      include: { table: true },
    });
  });
  res.status(201).json({ id: created.id, startsAt: created.startsAt, partySize: created.partySize, table: created.table.label });
}));
