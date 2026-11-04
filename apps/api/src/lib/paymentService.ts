import { Prisma } from '@prisma/client';
import { HttpError, env, prisma } from './core';
import { PaymentAdapter, PaymentEvent, activeAdapter, configuredAdapters } from './payments';
import { applySubscriptionPaymentEvent } from './billing';
import { adapterForAccount } from './paymentAccounts';

type Tx = Prisma.TransactionClient;

/** Creates (or reuses) a pending payment for an order and a provider checkout for it. */
export async function startCheckout(orderId: string, adapter: PaymentAdapter, accountId: string | null = null) {
  const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: { restaurant: true } });
  const existing = await prisma.payment.findFirst({ where: { orderId, provider: adapter.name, accountId, status: 'PENDING', checkoutUrl: { not: null } } });
  if (existing) return existing;
  const payment = await prisma.payment.create({
    data: { restaurantId: order.restaurantId, orderId, provider: adapter.name, accountId, amountCents: order.totalCents, currency: order.restaurant.currency },
  });
  try {
    const c = await adapter.createCheckout({
      paymentId: payment.id, amountCents: payment.amountCents, currency: payment.currency,
      description: `${order.restaurant.name} order #${order.number}`,
      customer: { name: order.customerName, phone: order.customerPhone },
      returnUrl: `${env.webOrigin}/track/${order.trackingCode}`,
    });
    return await prisma.payment.update({ where: { id: payment.id }, data: { providerRef: c.providerRef, checkoutUrl: c.url } });
  } catch (e) {
    await prisma.payment.update({ where: { id: payment.id }, data: { status: 'FAILED' } });
    throw e;
  }
}

async function cancelUnpaidOrder(tx: Tx, orderId: string) {
  const o = await tx.order.findUnique({ where: { id: orderId } });
  if (!o) return;
  const r = await tx.order.updateMany({ where: { id: o.id, status: 'PENDING_PAYMENT' }, data: { status: 'CANCELLED' } });
  if (!r.count) return;
  await tx.orderStatusHistory.create({ data: { orderId: o.id, status: 'CANCELLED' } });
  if (o.couponCode)
    await tx.coupon.updateMany({ where: { restaurantId: o.restaurantId, code: o.couponCode, usedCount: { gt: 0 } }, data: { usedCount: { decrement: 1 } } });
}

/**
 * Applies a verified provider event. Safe to call repeatedly: each event id is recorded once, and the
 * state change itself is a conditional update so a replay (or a different event for the same payment) is a no-op.
 */
export type EventScope = 'platform' | { restaurantId: string; accountId: string };

export async function applyEvent(provider: string, ev: PaymentEvent, scope: EventScope = 'platform'): Promise<'applied' | 'duplicate' | 'ignored'> {
  // event ids are only unique per provider account, so dedupe per account
  const dedupeKey = scope === 'platform' ? provider : `${provider}:${scope.accountId}`;
  return prisma.$transaction(async (tx) => {
    try {
      await tx.webhookEvent.create({ data: { provider: dedupeKey, eventId: ev.eventId } });
    } catch (e: any) {
      if (e.code === 'P2002') return 'duplicate';
      throw e;
    }
    const pay = await tx.payment.findFirst({
      where: scope === 'platform'
        ? { provider, providerRef: ev.providerRef, accountId: null }
        : { provider, providerRef: ev.providerRef, accountId: scope.accountId, restaurantId: scope.restaurantId },
    });
    if (!pay) {
      // Subscription invoices are paid to the platform, so only the platform webhook may settle them.
      return scope === 'platform' ? (await applySubscriptionPaymentEvent(tx, provider, ev)) ?? 'ignored' : 'ignored';
    }

    if (ev.kind === 'paid') {
      // Never trust a "paid" event whose amount differs from what we asked for.
      if (ev.amountCents != null && ev.amountCents !== pay.amountCents) {
        console.error(JSON.stringify({ event: 'payment.amount_mismatch', paymentId: pay.id, expected: pay.amountCents, got: ev.amountCents }));
        return 'ignored';
      }
      const r = await tx.payment.updateMany({ where: { id: pay.id, status: 'PENDING' }, data: { status: 'SUCCEEDED', paidAt: new Date(), providerPaymentId: ev.providerPaymentId } });
      if (!r.count) return 'ignored';
      const o = await tx.order.updateMany({ where: { id: pay.orderId, status: 'PENDING_PAYMENT' }, data: { status: 'NEW', paymentStatus: 'PAID' } });
      if (o.count) await tx.orderStatusHistory.create({ data: { orderId: pay.orderId, status: 'NEW' } });
      else await tx.order.update({ where: { id: pay.orderId }, data: { paymentStatus: 'PAID' } }); // paid after cancel: flag for manual refund
      return 'applied';
    }
    const r = await tx.payment.updateMany({ where: { id: pay.id, status: 'PENDING' }, data: { status: 'FAILED' } });
    if (!r.count) return 'ignored';
    await cancelUnpaidOrder(tx, pay.orderId);
    return 'applied';
  });
}

/** Refunds part or all of a succeeded online payment. Rows are reserved in the DB before the provider is called. */
export async function refundOrder(opts: { restaurantId: string; orderId: string; amountCents?: number; reason?: string; actorId: string }) {
  const pay = await prisma.payment.findFirst({
    where: { orderId: opts.orderId, restaurantId: opts.restaurantId, status: 'SUCCEEDED' }, include: { refunds: true },
  });
  if (!pay) throw new HttpError(404, 'No online payment to refund for this order', 'not_found');
  const adapter = pay.accountId ? await adapterForAccount(pay.accountId) : configuredAdapters()[pay.provider];
  if (!adapter) throw new HttpError(503, `Provider ${pay.provider} is not available to refund this payment`, 'provider_unavailable');

  const refund = await prisma.$transaction(async (tx) => {
    // lock the payment row so concurrent refunds are serialised
    await tx.$queryRaw`SELECT id FROM "Payment" WHERE id = ${pay.id} FOR UPDATE`;
    const done = await tx.refund.aggregate({ where: { paymentId: pay.id }, _sum: { amountCents: true } });
    const remaining = pay.amountCents - (done._sum.amountCents ?? 0);
    const amount = opts.amountCents ?? remaining;
    if (amount <= 0 || amount > remaining) throw new HttpError(400, `Refund must be between 1 and ${remaining}`, 'validation', { amountCents: [`Max ${remaining}`] });
    return tx.refund.create({ data: { paymentId: pay.id, amountCents: amount, reason: opts.reason, actorId: opts.actorId } });
  });

  try {
    const r = await adapter.refund({ paymentId: pay.id, providerRef: pay.providerRef!, providerPaymentId: pay.providerPaymentId, amountCents: refund.amountCents, idempotencyKey: `refund-${refund.id}` });
    await prisma.refund.update({ where: { id: refund.id }, data: { providerRef: r.providerRef } });
  } catch (e) {
    await prisma.refund.delete({ where: { id: refund.id } }); // provider rejected: release the reservation
    throw e;
  }
  const total = (await prisma.refund.aggregate({ where: { paymentId: pay.id }, _sum: { amountCents: true } }))._sum.amountCents ?? 0;
  const paymentStatus = total >= pay.amountCents ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
  await prisma.order.update({ where: { id: opts.orderId }, data: { paymentStatus } });
  await prisma.auditLog.create({ data: { restaurantId: opts.restaurantId, actorId: opts.actorId, action: 'payment.refund', detail: { orderId: opts.orderId, refundId: refund.id, amountCents: refund.amountCents } } });
  return { refundId: refund.id, amountCents: refund.amountCents, paymentStatus };
}

export const onlinePaymentsAvailable = () => !!activeAdapter();
