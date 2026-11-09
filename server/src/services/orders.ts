import type { OrderStatus, OrderType, Prisma, Role } from '@prisma/client';
import { prisma, dec, type Tx } from '../db.js';
import { ApiError, badRequest, conflict, forbidden, notFound } from '../lib/http.js';
import { broadcast } from '../lib/events.js';
import { getSettings } from '../lib/settings.js';
import { can } from '../lib/permissions.js';
import { config } from '../config.js';
import { notify, staffAlert } from './notify.js';
import { priceCart, type CartInput, type Priced } from './pricing.js';
import { applyCompletionRewards } from './loyalty.js';
import { consumeInventory } from './inventory.js';

export const TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  NEW: ['ACCEPTED', 'REJECTED', 'CANCELLED'],
  ACCEPTED: ['PREPARING', 'CANCELLED'],
  PREPARING: ['READY', 'CANCELLED'],
  READY: ['OUT_FOR_DELIVERY', 'SERVED', 'COMPLETED', 'CANCELLED'],
  OUT_FOR_DELIVERY: ['COMPLETED'],
  SERVED: ['COMPLETED'],
  COMPLETED: [],
  REJECTED: [],
  CANCELLED: [],
};
const ONLINE_METHODS = ['CARD', 'STRIPE', 'RAZORPAY', 'PAYNOW', 'UPI'];

function allowedNext(from: OrderStatus, type: OrderType): OrderStatus[] {
  return TRANSITIONS[from].filter((to) => {
    if (to === 'OUT_FOR_DELIVERY') return type === 'DELIVERY';
    if (to === 'SERVED') return type === 'DINE_IN';
    if (from === 'READY' && to === 'COMPLETED') return type === 'TAKEAWAY' || type === 'PICKUP';
    return true;
  });
}

export const orderInclude = {
  items: true,
  history: { orderBy: { createdAt: 'asc' } },
  payments: true,
  table: true,
  customer: { select: { id: true, name: true, phone: true, email: true, loyaltyPoints: true, tier: true } },
  assignedTo: { select: { id: true, name: true } },
  driver: { select: { id: true, name: true } },
} satisfies Prisma.OrderInclude;

export interface CreateOrderArgs extends CartInput {
  guest?: { name?: string; phone?: string; email?: string };
  tableToken?: string;
  tableLabel?: string;
  tableId?: string;
  sessionId?: string;
  deliveryAddress?: string;
  deliveryNotes?: string;
  scheduledFor?: Date;
  notes?: string;
  idempotencyKey?: string;
  outletId?: string;
  createdByStaff?: boolean;
}

export async function createOrder(args: CreateOrderArgs) {
  const s = await getSettings();
  if (!args.customerId && !args.createdByStaff && !s.ordering.guestCheckout)
    throw new ApiError(401, 'LOGIN_REQUIRED', 'Please sign in to place an order');

  if (args.idempotencyKey) {
    const dup = await prisma.order.findUnique({ where: { idempotencyKey: args.idempotencyKey }, include: orderInclude });
    if (dup) return dup;
  }

  let tableId = args.tableId;
  if (args.tableToken) {
    const t = await prisma.diningTable.findUnique({ where: { qrToken: args.tableToken } });
    if (!t || !t.isActive) throw notFound('Table');
    tableId = t.id;
    args.outletId = t.outletId ?? args.outletId;
    args.type = 'DINE_IN';
  }
  if (!tableId && args.tableLabel && args.type === 'DINE_IN') {
    // customer typed their table number (no QR): staff still confirm the order before the kitchen starts
    const t = await prisma.diningTable.findUnique({ where: { label: args.tableLabel } });
    if (!t || !t.isActive) throw badRequest('Table not found — check the number on your table');
    tableId = t.id;
  }
  if (args.type === 'DINE_IN' && !tableId) throw badRequest('Please choose your table for dine-in');
  if (tableId && !args.outletId) args.outletId = (await prisma.diningTable.findUnique({ where: { id: tableId } }))?.outletId ?? undefined;
  if (args.outletId) {
    const ob = await prisma.outlet.findUnique({ where: { id: args.outletId } });
    if (!ob?.isActive) throw badRequest('That branch is not available');
  } else if ((await getSettings()).site.multiOutlet && !args.createdByStaff) throw badRequest('Please choose a branch');
  if (args.type !== 'DINE_IN') tableId = undefined;
  if (args.type === 'DELIVERY' && !args.deliveryAddress?.trim()) throw badRequest('Delivery address is required');
  // A second order from the same table reuses the contact details given on the first one (same open table session).
  if (tableId && !args.customerId && !args.createdByStaff && !args.guest?.phone && !args.guest?.email) {
    const known = await sessionContact(tableId);
    if (known) args.guest = { name: args.guest?.name || known.name || undefined, phone: known.phone ?? undefined, email: known.email ?? undefined };
  }
  if (!args.customerId && !args.createdByStaff && !args.guest?.phone && !args.guest?.email)
    throw badRequest('Please provide a phone number or email so we can reach you');
  if (args.scheduledFor) {
    if (!s.ordering.scheduledOrdersEnabled) throw badRequest('Scheduled orders are not enabled');
    if (args.scheduledFor.getTime() < Date.now() + 15 * 60_000) throw badRequest('Scheduled time must be at least 15 minutes from now');
  }

  const priced = await priceCart({ ...args });

  // Guests who leave contact details become CRM records (unregistered, no login) so repeat visits are recognised.
  let linkedCustomerId = args.customerId ?? undefined;
  if (!linkedCustomerId && (args.guest?.phone || args.guest?.email)) {
    const email = args.guest.email?.toLowerCase();
    const found = await prisma.customer.findFirst({ where: { OR: [...(args.guest.phone ? [{ phone: args.guest.phone }] : []), ...(email ? [{ email }] : [])] } });
    linkedCustomerId = found?.id ?? (await prisma.customer.create({ data: { name: args.guest.name || 'Guest', phone: args.guest.phone, email } }).catch(() => null))?.id;
  }

  const order = await prisma.$transaction(async (tx) => {
    // table session: reuse the open one so multiple orders share a bill
    let sessionId = args.sessionId;
    if (tableId && !sessionId) {
      const open = await tx.tableSession.findFirst({ where: { tableId, closedAt: null } });
      sessionId = open?.id ?? (await tx.tableSession.create({ data: { tableId } })).id;
      await tx.diningTable.update({ where: { id: tableId }, data: { status: 'OCCUPIED' } });
    }

    // atomic coupon redemption (no oversell under concurrency)
    if (priced.couponId) {
      const r = await tx.$executeRaw`UPDATE "Coupon" SET "usedCount" = "usedCount" + 1 WHERE id = ${priced.couponId} AND ("maxUses" IS NULL OR "usedCount" < "maxUses")`;
      if (r === 0) throw badRequest('This promo code has been fully redeemed');
    }
    if (priced.voucherId) {
      const r = await tx.voucher.updateMany({ where: { id: priced.voucherId, usedAt: null }, data: { usedAt: new Date() } });
      if (r.count === 0) throw badRequest('This voucher has already been used');
    }
    if (priced.pointsRedeemed && args.customerId) {
      const r = await tx.customer.updateMany({
        where: { id: args.customerId, loyaltyPoints: { gte: priced.pointsRedeemed } },
        data: { loyaltyPoints: { decrement: priced.pointsRedeemed } },
      });
      if (r.count === 0) throw badRequest('Not enough loyalty points');
    }

    // daily order number: restarts at 1 each business day (restaurant timezone); serialised per day by an advisory lock
    const tz = (await tx.restaurant.findUnique({ where: { id: 'minerva' } }))?.timezone ?? 'Asia/Singapore';
    const businessDate = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'ordno:' + businessDate}))`;
    const last = await tx.order.aggregate({ where: { businessDate }, _max: { number: true } });
    const number = (last._max.number ?? 0) + 1;

    const o = await tx.order.create({
      data: {
        number, businessDate,
        type: args.type,
        customerId: linkedCustomerId,
        guestName: args.guest?.name, guestPhone: args.guest?.phone, guestEmail: args.guest?.email?.toLowerCase(),
        tableId, sessionId, outletId: args.outletId,
        deliveryAddress: args.deliveryAddress, deliveryPostal: args.deliveryPostal, deliveryZoneId: priced.deliveryZoneId,
        deliveryNotes: args.deliveryNotes, scheduledFor: args.scheduledFor, notes: args.notes?.slice(0, 500),
        subtotal: dec(priced.subtotal), discount: dec(priced.discount), serviceCharge: dec(priced.serviceCharge),
        tax: dec(priced.tax), deliveryFee: dec(priced.deliveryFee), tip: dec(priced.tip), total: dec(priced.total),
        couponId: priced.couponId, voucherCode: args.voucherCode?.toUpperCase(), pointsRedeemed: priced.pointsRedeemed,
        prepMinutes: priced.prepMinutes, idempotencyKey: args.idempotencyKey,
        items: {
          create: priced.lines.map((l) => ({
            productId: l.productId, name: l.name, variantName: l.variantName, addons: l.addons as any,
            quantity: l.quantity, unitPrice: dec(l.unitPrice), lineTotal: dec(l.lineTotal), notes: l.notes,
          })),
        },
        history: { create: { status: 'NEW' } },
      },
      include: orderInclude,
    });
    if (priced.pointsRedeemed && args.customerId)
      await tx.loyaltyTransaction.create({ data: { customerId: args.customerId, points: -priced.pointsRedeemed, reason: 'REDEEM', orderId: o.id } });
    return o;
  });

  broadcast('staff', 'order.new', { id: order.id, number: order.number, type: order.type, total: order.total });
  void staffAlert('order', `New ${order.type.replace('_', ' ').toLowerCase()} order #${order.number}`);
  void notify('order.placed', recipientOf(order), orderVars(order));
  void notifyCustomers(order, 'order.updated', { status: 'NEW', number: order.number });
  return order;
}

/** Contact details from the most recent order of the table's open session, if any. */
export async function sessionContact(tableId: string) {
  const s = await prisma.tableSession.findFirst({ where: { tableId, closedAt: null } });
  if (!s) return null;
  const prev = await prisma.order.findFirst({
    where: { sessionId: s.id, status: { notIn: ['CANCELLED', 'REJECTED', 'COMPLETED'] }, OR: [{ guestPhone: { not: null } }, { guestEmail: { not: null } }] },
    orderBy: { createdAt: 'desc' },
  }); // only while an order at the table is still open — a finished visit must not leak contact details to the next party
  return prev ? { name: prev.guestName, phone: prev.guestPhone, email: prev.guestEmail } : null;
}

/**
 * Push a change to every customer page watching this order — and, for table orders, to the pages of all other
 * orders in the same table visit (their merged view shows every order's status).
 */
export async function notifyCustomers(order: { id: string; trackingToken: string; sessionId: string | null }, type: string, payload: unknown = {}) {
  const tokens = new Set([order.trackingToken]);
  if (order.sessionId) {
    const sib = await prisma.order.findMany({ where: { sessionId: order.sessionId }, select: { trackingToken: true } });
    sib.forEach((s) => tokens.add(s.trackingToken));
  }
  tokens.forEach((t) => broadcast(`order:${t}`, type, payload));
}

export const recipientOf = (o: { guestName: string | null; guestPhone: string | null; guestEmail: string | null; customer?: { name: string; phone: string | null; email: string | null } | null }) => ({
  name: o.customer?.name ?? o.guestName, phone: o.customer?.phone ?? o.guestPhone, email: o.customer?.email ?? o.guestEmail,
});
export const orderVars = (o: { number: number; total: any; trackingToken: string }) => ({
  number: o.number, total: Number(o.total).toFixed(2), trackUrl: `${config.PUBLIC_WEB_URL}/track/${o.trackingToken}`,
});

export interface Actor { id: string; role: Role }

export async function changeStatus(orderId: string, to: OrderStatus, actor: Actor, note?: string) {
  const order = await prisma.order.findUnique({ where: { id: orderId }, include: { payments: true, items: true } });
  if (!order) throw notFound('Order');

  // role scoping
  const full = can(actor.role, 'orders.manage');
  if (!full) {
    const kitchenOk = can(actor.role, 'kitchen.manage') && ['ACCEPTED', 'PREPARING', 'READY', 'REJECTED'].includes(to);
    const floorOk = can(actor.role, 'orders.create') && ['SERVED', 'COMPLETED'].includes(to) && order.type === 'DINE_IN';
    const driverOk = can(actor.role, 'delivery.update') && ['OUT_FOR_DELIVERY', 'COMPLETED'].includes(to) && order.type === 'DELIVERY' && order.driverId === actor.id;
    if (!kitchenOk && !floorOk && !driverOk) throw forbidden('Your role cannot move this order to that status');
  }
  if (!allowedNext(order.status, order.type).includes(to))
    throw conflict(`Cannot move a ${order.status.replace(/_/g, ' ').toLowerCase()} ${order.type.replace('_', ' ').toLowerCase()} order to ${to.replace(/_/g, ' ').toLowerCase()}`);

  if (to === 'ACCEPTED') {
    const online = order.payments.filter((p) => ONLINE_METHODS.includes(p.method));
    if (online.length && !online.some((p) => p.status === 'PAID'))
      throw conflict('Online payment has not been confirmed by the payment provider yet');
  }
  if (to === 'OUT_FOR_DELIVERY' && !order.driverId) throw conflict('Assign a delivery driver first');

  const updated = await prisma.$transaction(async (tx) => {
    // optimistic guard so two staff can't apply conflicting transitions
    const r = await tx.order.updateMany({
      where: { id: orderId, status: order.status },
      data: {
        status: to,
        completedAt: to === 'COMPLETED' ? new Date() : undefined,
        assignedToId: to === 'ACCEPTED' ? actor.id : undefined,
        ...(to === 'PREPARING' ? { items: undefined } : {}),
      },
    });
    if (r.count === 0) throw conflict('This order was just updated by someone else — refresh and try again');
    await tx.orderStatusHistory.create({ data: { orderId, status: to, byUserId: actor.id, note } });
    if (to === 'READY') await tx.orderItem.updateMany({ where: { orderId }, data: { status: 'READY' } });
    if (to === 'PREPARING') await tx.orderItem.updateMany({ where: { orderId, status: 'PENDING' }, data: { status: 'PREPARING' } });

    if (to === 'COMPLETED') {
      await consumeInventory(tx, orderId);
      await applyCompletionRewards(tx, orderId);
      if (order.sessionId) await maybeCloseSession(tx, order.sessionId, orderId);
    }
    if (to === 'CANCELLED' || to === 'REJECTED') await releaseBenefits(tx, orderId);
    return tx.order.findUniqueOrThrow({ where: { id: orderId }, include: orderInclude });
  });

  const evt = `order.${to.toLowerCase()}`;
  broadcast('staff', 'order.updated', { id: updated.id, number: updated.number, status: to });
  void notifyCustomers(updated, 'order.updated', { status: to, number: updated.number });
  void notify(evt, recipientOf(updated), { ...orderVars(updated), reason: note ?? '' });
  return updated;
}

async function maybeCloseSession(tx: Tx, sessionId: string, exceptOrderId: string) {
  const open = await tx.order.count({ where: { sessionId, id: { not: exceptOrderId }, status: { notIn: ['COMPLETED', 'CANCELLED', 'REJECTED'] } } });
  void open; // sessions are closed explicitly by staff after the bill is settled
}

/** Give back points, coupon use and voucher when an order never fulfilled. */
async function releaseBenefits(tx: Tx, orderId: string) {
  const o = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
  if (o.couponId) await tx.coupon.updateMany({ where: { id: o.couponId, usedCount: { gt: 0 } }, data: { usedCount: { decrement: 1 } } });
  if (o.voucherCode) await tx.voucher.updateMany({ where: { code: o.voucherCode }, data: { usedAt: null } });
  if (o.pointsRedeemed && o.customerId) {
    const exists = await tx.loyaltyTransaction.findUnique({ where: { orderId_reason: { orderId, reason: 'REFUND_POINTS' } } });
    if (!exists) {
      await tx.customer.update({ where: { id: o.customerId }, data: { loyaltyPoints: { increment: o.pointsRedeemed } } });
      await tx.loyaltyTransaction.create({ data: { customerId: o.customerId, points: o.pointsRedeemed, reason: 'REFUND_POINTS', orderId } });
    }
  }
  if (o.tableId && o.sessionId) {
    const others = await tx.order.count({ where: { sessionId: o.sessionId, id: { not: orderId }, status: { notIn: ['CANCELLED', 'REJECTED'] } } });
    if (!others) {
      await tx.tableSession.update({ where: { id: o.sessionId }, data: { closedAt: new Date() } });
      await tx.diningTable.update({ where: { id: o.tableId }, data: { status: 'AVAILABLE' } });
    }
  }
}

export async function setItemStatus(orderId: string, itemId: string, status: 'PENDING' | 'PREPARING' | 'READY') {
  const item = await prisma.orderItem.findFirst({ where: { id: itemId, orderId } });
  if (!item) throw notFound('Item');
  await prisma.orderItem.update({ where: { id: itemId }, data: { status } });
  const ord = await prisma.order.findUnique({ where: { id: orderId }, select: { id: true, trackingToken: true, sessionId: true } });
  if (ord) void notifyCustomers(ord, 'order.updated', { itemId, itemStatus: status });
  broadcast('staff', 'order.updated', { id: orderId, itemId, itemStatus: status });
}

export type { Priced };
