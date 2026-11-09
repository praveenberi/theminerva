import crypto from 'node:crypto';
import type { PaymentMethod } from '@prisma/client';
import { prisma, dec } from '../db.js';
import { ApiError, badRequest, conflict, notFound } from '../lib/http.js';
import { config } from '../config.js';
import { getSettings } from '../lib/settings.js';
import { toCents, fromCents } from '../lib/money.js';
import { broadcast } from '../lib/events.js';
import { notify, staffAlert } from './notify.js';
import { orderVars, recipientOf, orderInclude, notifyCustomers } from './orders.js';

const CASH: PaymentMethod[] = ['CASH_AT_RESTAURANT', 'CASH_ON_DELIVERY'];
const providerFor = (m: PaymentMethod): 'stripe' | 'razorpay' | null =>
  m === 'CARD' || m === 'STRIPE' || m === 'PAYNOW' ? 'stripe' : m === 'RAZORPAY' || m === 'UPI' ? 'razorpay' : null;

const notConfigured = (p: string) => new ApiError(503, 'PROVIDER_NOT_CONFIGURED', `${p} is not configured on this server. Payment cannot be taken online yet.`);

async function form(url: string, body: Record<string, string>, auth: string, extra: Record<string, string> = {}) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded', ...extra },
    body: new URLSearchParams(body),
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(502, 'PROVIDER_ERROR', j?.error?.message ?? `Provider error ${r.status}`);
  return j;
}

export async function paidSoFar(orderId: string) {
  const ps = await prisma.payment.findMany({ where: { orderId, status: { in: ['PAID', 'PARTIALLY_REFUNDED'] } } });
  return ps.reduce((a, p) => a + toCents(p.amount), 0);
}

export async function createPayment(orderId: string, method: PaymentMethod, opts: { idempotencyKey?: string; amount?: number } = {}) {
  const s = await getSettings();
  if (!s.payments.enabledMethods.includes(method)) throw badRequest('That payment method is not available');
  if (opts.idempotencyKey) {
    const dup = await prisma.payment.findUnique({ where: { idempotencyKey: opts.idempotencyKey } });
    if (dup) return { payment: dup, clientSecret: undefined as string | undefined, duplicate: true };
  }
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) throw notFound('Order');
  if (['CANCELLED', 'REJECTED'].includes(order.status)) throw conflict('This order is closed');
  if (method === 'CASH_ON_DELIVERY' && order.type !== 'DELIVERY') throw badRequest('Cash on delivery only applies to delivery orders');
  if (method === 'CASH_AT_RESTAURANT' && order.type === 'DELIVERY') throw badRequest('Choose cash on delivery for delivery orders');

  const remaining = toCents(order.total) - (await paidSoFar(orderId));
  if (remaining <= 0) throw conflict('This order is already paid');
  const amountCents = opts.amount ? Math.min(toCents(opts.amount), remaining) : remaining; // split payments allowed
  const provider = providerFor(method);

  // block duplicate pending online payments for the same order (double-click / retry)
  if (provider) {
    const pending = await prisma.payment.findFirst({ where: { orderId, method, status: 'PENDING', providerRef: { not: null } } });
    if (pending && toCents(pending.amount) === amountCents) {
      return { payment: pending, clientSecret: undefined, duplicate: true };
    }
  }

  const payment = await prisma.payment.create({
    data: { orderId, method, provider, amount: dec(fromCents(amountCents)), idempotencyKey: opts.idempotencyKey },
  });
  if (!provider) return { payment, clientSecret: undefined as string | undefined };

  try {
    if (provider === 'stripe') {
      if (!config.STRIPE_SECRET_KEY) throw notConfigured('Stripe');
      const types = method === 'PAYNOW' ? 'paynow' : 'card';
      const pi = await form('https://api.stripe.com/v1/payment_intents', {
        amount: String(amountCents), currency: (await currency()).toLowerCase(), 'payment_method_types[]': types,
        'metadata[paymentId]': payment.id, 'metadata[orderNumber]': String(order.number),
      }, `Bearer ${config.STRIPE_SECRET_KEY}`, { 'Idempotency-Key': payment.id });
      const up = await prisma.payment.update({ where: { id: payment.id }, data: { providerRef: pi.id } });
      return { payment: up, clientSecret: pi.client_secret as string, publishableHint: 'Use Stripe.js with the returned clientSecret' };
    }
    if (!config.RAZORPAY_KEY_ID || !config.RAZORPAY_KEY_SECRET) throw notConfigured('Razorpay');
    const auth = 'Basic ' + Buffer.from(`${config.RAZORPAY_KEY_ID}:${config.RAZORPAY_KEY_SECRET}`).toString('base64');
    const r = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: amountCents, currency: await currency(), receipt: payment.reference, notes: { paymentId: payment.id } }),
    });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok) throw new ApiError(502, 'PROVIDER_ERROR', j?.error?.description ?? `Razorpay error ${r.status}`);
    const up = await prisma.payment.update({ where: { id: payment.id }, data: { providerRef: j.id } });
    return { payment: up, clientSecret: undefined, razorpay: { orderId: j.id, keyId: config.RAZORPAY_KEY_ID, amount: amountCents } };
  } catch (e) {
    await prisma.payment.update({ where: { id: payment.id }, data: { status: 'FAILED' } });
    throw e;
  }
}

async function currency() {
  return (await prisma.restaurant.findUnique({ where: { id: 'minerva' } }))?.currency ?? 'SGD';
}

/** Only call this with provider confirmation (webhook) or a cashier physically taking cash. */
export async function markPaid(paymentId: string, confirmedBy: 'provider' | 'staff') {
  const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
  if (!payment) throw notFound('Payment');
  if (payment.status === 'PAID') return payment;
  if (payment.status !== 'PENDING' && payment.status !== 'AUTHORIZED' && payment.status !== 'FAILED') throw conflict(`Payment is ${payment.status}`);
  if (confirmedBy === 'staff' && !CASH.includes(payment.method)) throw badRequest('Online payments are confirmed by the provider, not manually');
  const up = await prisma.payment.updateMany({ where: { id: paymentId, status: payment.status }, data: { status: 'PAID', paidAt: new Date() } });
  if (up.count === 0) return prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
  const order = await prisma.order.findUniqueOrThrow({ where: { id: payment.orderId }, include: orderInclude });
  broadcast('staff', 'payment.paid', { orderId: order.id, number: order.number });
  void notifyCustomers(order, 'payment.paid', {});
  void notify('payment.confirmed', recipientOf(order), { ...orderVars(order), amount: Number(payment.amount).toFixed(2) });
  return prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
}

export async function markFailed(paymentId: string) {
  const p = await prisma.payment.updateMany({ where: { id: paymentId, status: 'PENDING' }, data: { status: 'FAILED' } });
  if (p.count) void staffAlert('payment_failed', `A payment attempt failed (ref ${paymentId.slice(-6)})`);
}

// ───────── webhooks ─────────
export function verifyStripeSignature(raw: Buffer, header: string | undefined, secret: string, toleranceSec = 300) {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(',').map((kv) => kv.split('=') as [string, string]));
  const t = parts.t, sig = parts.v1;
  if (!t || !sig) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > toleranceSec) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${raw.toString('utf8')}`).digest('hex');
  const a = Buffer.from(expected), b = Buffer.from(sig);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
export function verifyRazorpaySignature(raw: Buffer, header: string | undefined, secret: string) {
  if (!header) return false;
  const expected = crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const a = Buffer.from(expected), b = Buffer.from(header);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Records the event id; returns false if we already processed it (replay protection). */
async function firstTime(id: string, provider: string) {
  try { await prisma.webhookEvent.create({ data: { id, provider } }); return true; } catch { return false; }
}

export async function handleStripeEvent(evt: any) {
  if (!(await firstTime(evt.id, 'stripe'))) return { duplicate: true };
  const obj = evt.data?.object;
  if (evt.type === 'payment_intent.succeeded') {
    const p = await prisma.payment.findUnique({ where: { providerRef: obj.id } });
    if (p) {
      // amount must match what we asked for — never trust the event blindly
      if (obj.amount_received !== toCents(p.amount)) { await staffAlert('payment_failed', `Stripe amount mismatch on ${p.reference}`); return { mismatch: true }; }
      await markPaid(p.id, 'provider');
    }
  } else if (evt.type === 'payment_intent.payment_failed') {
    const p = await prisma.payment.findUnique({ where: { providerRef: obj.id } });
    if (p) await markFailed(p.id);
  }
  return { ok: true };
}

export async function handleRazorpayEvent(evt: any, eventId: string) {
  if (!(await firstTime(eventId, 'razorpay'))) return { duplicate: true };
  const ent = evt.payload?.payment?.entity;
  if (!ent) return { ok: true };
  const p = await prisma.payment.findUnique({ where: { providerRef: ent.order_id } });
  if (!p) return { ok: true };
  if (evt.event === 'payment.captured') {
    if (ent.amount !== toCents(p.amount)) { await staffAlert('payment_failed', `Razorpay amount mismatch on ${p.reference}`); return { mismatch: true }; }
    await markPaid(p.id, 'provider');
  } else if (evt.event === 'payment.failed') await markFailed(p.id);
  return { ok: true };
}

// ───────── refunds ─────────
export async function refund(paymentId: string, amount: number | undefined, reason: string | undefined, userId: string) {
  const payment = await prisma.payment.findUnique({ where: { id: paymentId }, include: { refunds: true, order: true } });
  if (!payment) throw notFound('Payment');
  if (!['PAID', 'PARTIALLY_REFUNDED'].includes(payment.status)) throw conflict('Only paid payments can be refunded');
  const already = payment.refunds.reduce((a, r) => a + toCents(r.amount), 0);
  const left = toCents(payment.amount) - already;
  const cents = amount === undefined ? left : toCents(amount);
  if (cents <= 0) throw badRequest('Refund amount must be positive');
  if (cents > left) throw badRequest(`Cannot refund more than the remaining ${fromCents(left).toFixed(2)}`);

  let providerRef: string | undefined;
  if (payment.provider === 'stripe') {
    if (!config.STRIPE_SECRET_KEY) throw notConfigured('Stripe');
    const r = await form('https://api.stripe.com/v1/refunds', { payment_intent: payment.providerRef!, amount: String(cents) }, `Bearer ${config.STRIPE_SECRET_KEY}`, { 'Idempotency-Key': `refund-${payment.id}-${already}-${cents}` });
    providerRef = r.id;
  } else if (payment.provider === 'razorpay') {
    if (!config.RAZORPAY_KEY_ID || !config.RAZORPAY_KEY_SECRET) throw notConfigured('Razorpay');
    // Razorpay refunds reference the payment id (pay_*), which arrives via webhook; we store the order id, so look it up.
    const auth = 'Basic ' + Buffer.from(`${config.RAZORPAY_KEY_ID}:${config.RAZORPAY_KEY_SECRET}`).toString('base64');
    const pays: any = await (await fetch(`https://api.razorpay.com/v1/orders/${payment.providerRef}/payments`, { headers: { Authorization: auth } })).json();
    const captured = pays?.items?.find((x: any) => x.status === 'captured');
    if (!captured) throw new ApiError(502, 'PROVIDER_ERROR', 'Could not find the captured Razorpay payment');
    const rr = await fetch(`https://api.razorpay.com/v1/payments/${captured.id}/refund`, { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ amount: cents }) });
    const j: any = await rr.json().catch(() => ({}));
    if (!rr.ok) throw new ApiError(502, 'PROVIDER_ERROR', j?.error?.description ?? 'Razorpay refund failed');
    providerRef = j.id;
  }
  const row = await prisma.$transaction(async (tx) => {
    const created = await tx.refund.create({ data: { paymentId, amount: dec(fromCents(cents)), reason, providerRef, createdById: userId } });
    await tx.payment.update({ where: { id: paymentId }, data: { status: cents === left ? 'REFUNDED' : 'PARTIALLY_REFUNDED' } });
    return created;
  });
  const order = await prisma.order.findUniqueOrThrow({ where: { id: payment.orderId }, include: orderInclude });
  void notify('refund.confirmed', recipientOf(order), { ...orderVars(order), amount: fromCents(cents).toFixed(2) });
  return row;
}
