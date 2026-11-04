import { Router } from 'express';
import { z } from 'zod';
import { HttpError, parse, prisma } from '../lib/core';
import { assertFeature } from '../lib/billing';
import { PROVIDERS, activeAccount, connectAccount, describeAccount, disconnectAccount, secretSchemas, type Provider } from '../lib/paymentAccounts';
import { configuredAdapters } from '../lib/payments';
import { MANAGE, authenticate, requireRole, requireVerifiedEmail, rid, wrap } from '../middleware/auth';

export const paymentAccount = Router();
const owner = [authenticate, requireRole('OWNER')] as const;

const available = () => PROVIDERS.filter((p) => p !== 'test' || !!configuredAdapters().test);

/** Which provider this outlet takes money through. Never includes the secrets. */
paymentAccount.get('/payment-account', ...owner, wrap(async (req, res) => {
  const a = await activeAccount(rid(req));
  res.json({ account: a ? describeAccount(a) : null, providers: available() });
}));

paymentAccount.put('/payment-account', ...owner, requireVerifiedEmail, wrap(async (req, res) => {
  await assertFeature(req.user!.tenantId, 'online_payments');
  const { provider, secrets } = parse(z.object({ provider: z.enum(PROVIDERS), secrets: z.record(z.string(), z.string()).default({}) }), req.body);
  if (!available().includes(provider)) throw new HttpError(400, 'That provider is not available on this server', 'validation', { provider: ['Not available'] });
  const checked = secretSchemas[provider].safeParse(secrets);
  if (!checked.success) throw new HttpError(400, 'Check the credentials you pasted', 'validation', checked.error.flatten().fieldErrors);
  const a = await connectAccount(rid(req), provider as Provider, checked.data as Record<string, string>, req.user!.id);
  res.json({ account: describeAccount(a) });
}));

paymentAccount.delete('/payment-account', ...owner, wrap(async (req, res) => {
  await disconnectAccount(rid(req), req.user!.id);
  res.status(204).end();
}));

/** Online payments taken by this outlet, newest first, with what has been refunded. */
paymentAccount.get('/payments', authenticate, requireRole(...MANAGE), wrap(async (req, res) => {
  const rows = await prisma.payment.findMany({
    where: { restaurantId: rid(req) }, orderBy: { createdAt: 'desc' }, take: 100,
    include: { order: { select: { number: true, customerName: true } }, refunds: { select: { amountCents: true } } },
  });
  const settled = rows.filter((p) => p.status === 'SUCCEEDED');
  res.json({
    summary: {
      collectedCents: settled.reduce((s, p) => s + p.amountCents, 0),
      refundedCents: settled.reduce((s, p) => s + p.refunds.reduce((t, r) => t + r.amountCents, 0), 0),
      pending: rows.filter((p) => p.status === 'PENDING').length, failed: rows.filter((p) => p.status === 'FAILED').length,
    },
    payments: rows.map((p) => ({
      id: p.id, orderNumber: p.order.number, customer: p.order.customerName, provider: p.provider, amountCents: p.amountCents, currency: p.currency,
      status: p.status, createdAt: p.createdAt, paidAt: p.paidAt, refundedCents: p.refunds.reduce((s, r) => s + r.amountCents, 0),
    })),
  });
}));
