import express, { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { config } from '../config.js';
import { attachAuth, requirePerm } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { ApiError, badRequest, notFound, pageQuery, paged, paginate, parse, wrap } from '../lib/http.js';
import { createPayment, handleRazorpayEvent, handleStripeEvent, markPaid, refund, verifyRazorpaySignature, verifyStripeSignature } from '../services/payments.js';
import { csvStringify } from '../lib/csv.js';

export const paymentRouter = Router();

paymentRouter.post('/create', attachAuth, wrap(async (req, res) => {
  const b = parse(z.object({
    orderToken: z.string().optional(), orderId: z.string().optional(),
    method: z.enum(['CARD', 'STRIPE', 'RAZORPAY', 'PAYNOW', 'UPI', 'CASH_ON_DELIVERY', 'CASH_AT_RESTAURANT']),
    amount: z.number().positive().optional(),
  }), req.body);
  let orderId = b.orderId;
  if (b.orderToken) {
    const o = await prisma.order.findUnique({ where: { trackingToken: b.orderToken } });
    if (!o) throw notFound('Order');
    orderId = o.id;
  } else if (!req.staff) throw new ApiError(401, 'UNAUTHORIZED', 'Authentication required');
  else if (!['OWNER', 'MANAGER', 'CASHIER', 'WAITER'].includes(req.staff.role)) throw new ApiError(403, 'FORBIDDEN', 'You cannot take payments');
  if (!orderId) throw badRequest('orderToken or orderId is required');
  const key = typeof req.headers['idempotency-key'] === 'string' ? req.headers['idempotency-key'] : undefined;
  const r = await createPayment(orderId, b.method, { idempotencyKey: key, amount: req.staff ? b.amount : undefined });
  const { payment, duplicate, ...extra } = r as any;
  res.status(duplicate ? 200 : 201).json({ ...extra, payment: { id: payment.id, reference: payment.reference, status: payment.status, amount: payment.amount, method: payment.method } });
}));

// Webhooks need the *raw* body for signature checking, so they are mounted with express.raw
paymentRouter.post('/webhook', express.raw({ type: '*/*', limit: '1mb' }), wrap(async (req, res) => {
  const raw = req.body as Buffer;
  const stripeSig = req.headers['stripe-signature'] as string | undefined;
  const rzpSig = req.headers['x-razorpay-signature'] as string | undefined;
  if (stripeSig) {
    if (!config.STRIPE_WEBHOOK_SECRET) throw new ApiError(503, 'PROVIDER_NOT_CONFIGURED', 'Stripe webhook secret not configured');
    if (!verifyStripeSignature(raw, stripeSig, config.STRIPE_WEBHOOK_SECRET)) throw new ApiError(400, 'BAD_SIGNATURE', 'Invalid signature');
    return res.json(await handleStripeEvent(JSON.parse(raw.toString('utf8'))));
  }
  if (rzpSig) {
    if (!config.RAZORPAY_WEBHOOK_SECRET) throw new ApiError(503, 'PROVIDER_NOT_CONFIGURED', 'Razorpay webhook secret not configured');
    if (!verifyRazorpaySignature(raw, rzpSig, config.RAZORPAY_WEBHOOK_SECRET)) throw new ApiError(400, 'BAD_SIGNATURE', 'Invalid signature');
    return res.json(await handleRazorpayEvent(JSON.parse(raw.toString('utf8')), String(req.headers['x-razorpay-event-id'] ?? '')));
  }
  throw new ApiError(400, 'BAD_SIGNATURE', 'Missing signature');
}));

paymentRouter.post('/:id/confirm-cash', attachAuth, requirePerm('payments.process'), wrap(async (req, res) => {
  const p = await markPaid(req.params.id, 'staff');
  await audit(req, 'payment.cash_confirmed', 'Payment', p.id, { amount: p.amount });
  res.json(p);
}));

paymentRouter.post('/refund', attachAuth, requirePerm('payments.refund'), wrap(async (req, res) => {
  const b = parse(z.object({ paymentId: z.string(), amount: z.number().positive().optional(), reason: z.string().max(300).optional() }), req.body);
  const r = await refund(b.paymentId, b.amount, b.reason, req.staff!.id);
  await audit(req, 'payment.refund', 'Payment', b.paymentId, { amount: r.amount, reason: b.reason });
  res.status(201).json(r);
}));

paymentRouter.get('/', attachAuth, requirePerm('payments.process', 'reports.view'), wrap(async (req, res) => {
  const q = parse(pageQuery.extend({ status: z.string().optional(), method: z.string().optional(), from: z.coerce.date().optional(), to: z.coerce.date().optional() }), req.query);
  const where: any = {};
  if (q.status) where.status = q.status;
  if (q.method) where.method = q.method;
  if (q.from || q.to) where.createdAt = { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) };
  const [items, total, byMethod] = await Promise.all([
    prisma.payment.findMany({ where, ...paginate(q), orderBy: { createdAt: 'desc' }, include: { order: { select: { number: true } }, refunds: true } }),
    prisma.payment.count({ where }),
    prisma.payment.groupBy({ by: ['method', 'status'], where, _sum: { amount: true }, _count: true }),
  ]);
  res.json({ ...paged(items, total, q), summary: byMethod.map((g) => ({ method: g.method, status: g.status, count: g._count, amount: g._sum.amount })) });
}));

paymentRouter.get('/settlement.csv', attachAuth, requirePerm('reports.view'), wrap(async (req, res) => {
  const q = parse(z.object({ from: z.coerce.date(), to: z.coerce.date() }), req.query);
  const ps = await prisma.payment.findMany({ where: { status: { in: ['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED'] }, paidAt: { gte: q.from, lte: q.to } }, include: { order: { select: { number: true } }, refunds: true }, orderBy: { paidAt: 'asc' } });
  res.type('text/csv').attachment('settlement.csv').send(csvStringify([
    ['paid_at', 'order', 'method', 'provider', 'reference', 'amount', 'refunded', 'net'],
    ...ps.map((p) => { const rf = p.refunds.reduce((a, r) => a + Number(r.amount), 0); return [p.paidAt?.toISOString(), p.order.number, p.method, p.provider ?? 'manual', p.reference, p.amount, rf.toFixed(2), (Number(p.amount) - rf).toFixed(2)]; }),
  ]));
}));
