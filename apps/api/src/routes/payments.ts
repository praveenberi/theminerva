import { Router } from 'express';
import { z } from 'zod';
import { HttpError, parse, prisma } from '../lib/core';
import { configuredAdapters, signTestEvent } from '../lib/payments';
import { adapterFromSecrets } from '../lib/paymentAccounts';
import { decryptJson } from '../lib/secrets';
import { applyEvent, refundOrder, type EventScope } from '../lib/paymentService';
import { MANAGE, authenticate, requireRole, rid, wrap } from '../middleware/auth';

export const payments = Router();

/**
 * Mounted with express.raw() so the signature is verified against the exact bytes the provider sent.
 * Always answers 2xx for verified events (including duplicates) so providers stop retrying.
 */
/**
 * Each restaurant gets its own webhook URL (an unguessable token) and signing secret. The token selects the account
 * whose secret verifies the signature, and the event can only settle payments created through that same account.
 */
payments.post('/webhook/:provider/:token', wrap(async (req, res) => {
  const acct = await prisma.paymentAccount.findFirst({ where: { webhookToken: req.params.token, provider: req.params.provider } });
  if (!acct) throw new HttpError(404, 'Unknown webhook', 'not_found');
  if (!Buffer.isBuffer(req.body)) throw new HttpError(400, 'Expected raw body', 'bad_request');
  const adapter = adapterFromSecrets(acct.provider, decryptJson(acct.secretsEnc));
  const ev = adapter.parseWebhook(req.body, req.headers);
  const result = ev ? await applyEvent(acct.provider, ev, { restaurantId: acct.restaurantId, accountId: acct.id }) : 'ignored';
  res.json({ received: true, result });
}));

/** Platform webhook: subscription invoices and payments created before restaurants had their own accounts. */
payments.post('/webhook/:provider', wrap(async (req, res) => {
  const adapter = configuredAdapters()[req.params.provider];
  if (!adapter) throw new HttpError(404, 'Unknown provider', 'not_found');
  if (!Buffer.isBuffer(req.body)) throw new HttpError(400, 'Expected raw body', 'bad_request');
  const ev = adapter.parseWebhook(req.body, req.headers);
  const result = ev ? await applyEvent(adapter.name, ev, 'platform') : 'ignored';
  res.json({ received: true, result });
}));

payments.post('/refund', authenticate, requireRole(...MANAGE), wrap(async (req, res) => {
  const d = parse(z.object({ orderId: z.string(), amountCents: z.number().int().min(1).optional(), reason: z.string().max(200).optional() }), req.body);
  res.status(201).json(await refundOrder({ restaurantId: rid(req), actorId: req.user!.id, ...d }));
}));

// ---- test provider: stand-in hosted payment page (only exists when ENABLE_TEST_PAYMENTS=1 and not production) ----
export const testPay = Router();
testPay.use((_req, _res, next) => (configuredAdapters().test ? next() : next(new HttpError(404, 'Not found', 'not_found'))));

/** The dev-only provider can "pay" either an order payment or a subscription invoice payment. */
async function findTestPayment(id: string) {
  const o = await prisma.payment.findFirst({ where: { id, provider: 'test' }, include: { order: { include: { restaurant: { select: { name: true } } } } } });
  if (o) return { scope: (o.accountId ? { restaurantId: o.restaurantId, accountId: o.accountId } : 'platform') as EventScope, id: o.id, providerRef: o.providerRef, status: o.status, amountCents: o.amountCents, currency: o.currency, label: o.order.restaurant.name, trackingCode: o.order.trackingCode as string | null, returnPath: null as string | null };
  const sp = await prisma.subscriptionPayment.findFirst({ where: { id, provider: 'test' }, include: { invoice: { include: { tenant: { select: { name: true } } } } } });
  if (sp) return { scope: 'platform' as EventScope, id: sp.id, providerRef: sp.providerRef, status: sp.status, amountCents: sp.amountCents, currency: sp.currency, label: `${sp.invoice.tenant.name}: ${sp.invoice.description}`, trackingCode: null, returnPath: '/app/billing' };
  return null;
}

testPay.get('/:paymentId', wrap(async (req, res) => {
  const p = await findTestPayment(req.params.paymentId);
  if (!p) throw new HttpError(404, 'Not found', 'not_found');
  res.json({ status: p.status, amountCents: p.amountCents, currency: p.currency, restaurant: p.label, trackingCode: p.trackingCode, returnPath: p.returnPath });
}));

testPay.post('/:paymentId', wrap(async (req, res) => {
  const { outcome } = parse(z.object({ outcome: z.enum(['paid', 'failed']) }), req.body);
  const p = await findTestPayment(req.params.paymentId);
  if (!p || !p.providerRef) throw new HttpError(404, 'Not found', 'not_found');
  // Deliver through the real webhook path (signature check, dedupe, state change).
  const raw = JSON.stringify({ eventId: `evt_${p.id}_${outcome}`, kind: outcome, providerRef: p.providerRef, providerPaymentId: `pay_${p.id}`, amountCents: p.amountCents });
  const adapter = configuredAdapters().test;
  const ev = adapter.parseWebhook(Buffer.from(raw), { 'x-test-signature': signTestEvent(raw) });
  res.json({ result: ev ? await applyEvent('test', ev, p.scope) : 'ignored' });
}));
