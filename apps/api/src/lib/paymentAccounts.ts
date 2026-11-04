import crypto from 'node:crypto';
import { z } from 'zod';
import { HttpError, env, prisma } from './core';
import { PaymentAdapter, configuredAdapters, razorpayAdapter, stripeAdapter, testAdapter } from './payments';
import { decryptJson, encryptJson } from './secrets';

export const PROVIDERS = ['stripe', 'razorpay', 'test'] as const;
export type Provider = (typeof PROVIDERS)[number];

/** What a restaurant must paste in for each provider. Shapes are checked before anything is sent anywhere. */
export const secretSchemas = {
  stripe: z.object({
    secretKey: z.string().trim().regex(/^(sk|rk)_(test|live)_[A-Za-z0-9]{10,}$/, 'Paste a Stripe secret key (starts with sk_test_ or sk_live_)'),
    webhookSecret: z.string().trim().regex(/^whsec_[A-Za-z0-9]{8,}$/, 'Paste the webhook signing secret (starts with whsec_)'),
  }),
  razorpay: z.object({
    keyId: z.string().trim().regex(/^rzp_(test|live)_[A-Za-z0-9]{6,}$/, 'Paste your Razorpay Key Id (starts with rzp_test_ or rzp_live_)'),
    keySecret: z.string().trim().min(8, 'Paste your Razorpay Key Secret'),
    webhookSecret: z.string().trim().min(16, 'Use a webhook secret of at least 16 characters and paste the same one into Razorpay'),
  }),
  test: z.object({}).strict(),
};

type Secrets = Record<string, string>;

export function adapterFromSecrets(provider: string, s: Secrets): PaymentAdapter {
  if (provider === 'stripe') return stripeAdapter(s.secretKey, s.webhookSecret);
  if (provider === 'razorpay') return razorpayAdapter(s.keyId, s.keySecret, s.webhookSecret);
  if (provider === 'test') return testAdapter();
  throw new HttpError(400, 'Unknown payment provider', 'validation');
}

const modeOf = (provider: string, s: Secrets) => (provider === 'test' ? 'test' : (s.secretKey ?? s.keyId).includes('_live_') ? 'live' : 'test');
const hintOf = (provider: string, s: Secrets) => (provider === 'stripe' ? `…${s.secretKey.slice(-4)}` : provider === 'razorpay' ? s.keyId : 'sandbox');

/** Proves the credentials work by making one harmless read-only call to the provider. */
export async function verifyCredentials(provider: string, s: Secrets): Promise<{ ok: true } | { ok: false; error: string }> {
  if (provider === 'test') return configuredAdapters().test ? { ok: true } : { ok: false, error: 'The test provider is not enabled on this server' };
  const name = provider === 'stripe' ? 'Stripe' : 'Razorpay';
  try {
    const r = provider === 'stripe'
      ? await fetch('https://api.stripe.com/v1/account', { headers: { Authorization: `Bearer ${s.secretKey}` } })
      : await fetch('https://api.razorpay.com/v1/payments?count=1', { headers: { Authorization: `Basic ${Buffer.from(`${s.keyId}:${s.keySecret}`).toString('base64')}` } });
    if (r.ok) return { ok: true };
    if (r.status === 401 || r.status === 403) return { ok: false, error: `${name} rejected these credentials. Check that you copied them exactly.` };
    return { ok: false, error: `${name} returned an unexpected response (${r.status}). Try again in a moment.` };
  } catch {
    return { ok: false, error: `Could not reach ${name} to check the credentials. Try again in a moment.` };
  }
}

export const webhookUrl = (provider: string, token: string) =>
  `${process.env.PUBLIC_API_URL ?? `http://localhost:${env.port}`}/api/payments/webhook/${provider}/${token}`;

type Account = NonNullable<Awaited<ReturnType<typeof prisma.paymentAccount.findFirst>>>;
export const describeAccount = (a: Account) => ({
  id: a.id, provider: a.provider, keyHint: a.keyHint, mode: a.mode, verifiedAt: a.verifiedAt, createdAt: a.createdAt,
  webhookUrl: webhookUrl(a.provider, a.webhookToken), // secrets themselves are never returned
});

export const activeAccount = (restaurantId: string) => prisma.paymentAccount.findFirst({ where: { restaurantId, active: true }, orderBy: { createdAt: 'desc' } });
export const hasActiveAccount = async (restaurantId: string) => (await prisma.paymentAccount.count({ where: { restaurantId, active: true } })) > 0;

export async function adapterForAccount(accountId: string): Promise<PaymentAdapter | null> {
  const a = await prisma.paymentAccount.findUnique({ where: { id: accountId } });
  return a ? adapterFromSecrets(a.provider, decryptJson<Secrets>(a.secretsEnc)) : null;
}

/** The adapter new order checkouts for this restaurant should use, with the account that will own the payment. */
export async function checkoutAdapter(restaurantId: string) {
  const a = await activeAccount(restaurantId);
  return a ? { adapter: adapterFromSecrets(a.provider, decryptJson<Secrets>(a.secretsEnc)), accountId: a.id } : null;
}

/** Saves new credentials after verifying them. The previous account stays (inactive) so its refunds and late webhooks keep working. */
export async function connectAccount(restaurantId: string, provider: Provider, secrets: Secrets, actorId: string) {
  const mode = modeOf(provider, secrets);
  // Accidentally pointing a development server at a real money account is the costly mistake; refuse it.
  if (mode === 'live' && !env.isProd && process.env.ALLOW_LIVE_PAYMENT_KEYS !== '1')
    throw new HttpError(400, 'Live payment keys are only accepted when the server runs in production. Use your test keys here.', 'validation', { secretKey: ['Use a test key'] });
  const check = await verifyCredentials(provider, secrets);
  if (!check.ok) throw new HttpError(400, check.error, 'credentials_rejected');

  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Restaurant" WHERE id = ${restaurantId} FOR UPDATE`; // one active account at a time
    await tx.paymentAccount.updateMany({ where: { restaurantId, active: true }, data: { active: false } });
    const a = await tx.paymentAccount.create({
      data: { restaurantId, provider, secretsEnc: encryptJson(secrets), keyHint: hintOf(provider, secrets), mode, webhookToken: crypto.randomBytes(24).toString('base64url'), verifiedAt: new Date() },
    });
    await tx.auditLog.create({ data: { restaurantId, actorId, action: 'payment_account.connect', detail: { provider, mode, keyHint: a.keyHint } } });
    return a;
  });
}

export async function disconnectAccount(restaurantId: string, actorId: string) {
  await prisma.$transaction(async (tx) => {
    await tx.paymentAccount.updateMany({ where: { restaurantId, active: true }, data: { active: false } });
    await tx.restaurant.update({ where: { id: restaurantId }, data: { onlinePayments: false } }); // stop offering online payment at once
    await tx.auditLog.create({ data: { restaurantId, actorId, action: 'payment_account.disconnect' } });
  });
}
