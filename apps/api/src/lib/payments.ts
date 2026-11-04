import crypto from 'node:crypto';
import { HttpError, env } from './core';

export interface CheckoutInput {
  paymentId: string;
  amountCents: number;
  currency: string;
  description: string;
  customer: { name: string; phone: string };
  returnUrl: string;
}
export interface Checkout { providerRef: string; url: string }

/** Provider-neutral webhook result. Anything we don't act on is returned as null. */
export interface PaymentEvent {
  eventId: string;
  kind: 'paid' | 'failed';
  providerRef: string;
  providerPaymentId?: string;
  amountCents?: number;
}

export interface PaymentAdapter {
  name: string;
  createCheckout(i: CheckoutInput): Promise<Checkout>;
  /** Throws HttpError(400) when the signature is invalid. */
  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): PaymentEvent | null;
  refund(p: { paymentId: string; providerRef: string; providerPaymentId?: string | null; amountCents: number; idempotencyKey: string }): Promise<{ providerRef: string }>;
}

const hmac = (secret: string, data: string | Buffer, enc: 'hex' = 'hex') => crypto.createHmac('sha256', secret).update(data).digest(enc);
export function safeEqual(a: string, b: string) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
const header = (h: Record<string, string | string[] | undefined>, k: string) => {
  const v = h[k]; return Array.isArray(v) ? v[0] : v;
};
const bad = () => new HttpError(400, 'Invalid webhook signature', 'bad_signature');

// ---------------- Stripe (Checkout Sessions, REST, no SDK) ----------------
export function stripeAdapter(secretKey: string, webhookSecret: string): PaymentAdapter {
  const call = async (path: string, form: Record<string, string>, idem: string) => {
    const r = await fetch(`https://api.stripe.com/v1${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/x-www-form-urlencoded', 'Idempotency-Key': idem },
      body: new URLSearchParams(form),
    });
    const d: any = await r.json();
    if (!r.ok) throw new HttpError(502, d?.error?.message ?? 'Payment provider error', 'provider_error');
    return d;
  };
  return {
    name: 'stripe',
    async createCheckout(i) {
      const d = await call('/checkout/sessions', {
        mode: 'payment',
        'line_items[0][quantity]': '1',
        'line_items[0][price_data][currency]': i.currency.toLowerCase(),
        'line_items[0][price_data][unit_amount]': String(i.amountCents),
        'line_items[0][price_data][product_data][name]': i.description,
        'metadata[paymentId]': i.paymentId,
        success_url: i.returnUrl, cancel_url: i.returnUrl,
      }, `checkout-${i.paymentId}`);
      return { providerRef: d.id, url: d.url };
    },
    parseWebhook(raw, headers) {
      const sig = header(headers, 'stripe-signature') ?? '';
      const parts = Object.fromEntries(sig.split(',').map((p) => p.split('=') as [string, string]));
      const t = Number(parts.t);
      if (!t || Math.abs(Date.now() / 1000 - t) > 300) throw bad(); // replay window
      const expected = hmac(webhookSecret, `${parts.t}.${raw.toString('utf8')}`);
      if (!parts.v1 || !safeEqual(expected, parts.v1)) throw bad();
      const ev = JSON.parse(raw.toString('utf8'));
      const o = ev.data?.object;
      if (ev.type === 'checkout.session.completed' && o.payment_status === 'paid')
        return { eventId: ev.id, kind: 'paid', providerRef: o.id, providerPaymentId: o.payment_intent, amountCents: o.amount_total };
      if (ev.type === 'checkout.session.expired') return { eventId: ev.id, kind: 'failed', providerRef: o.id };
      return null;
    },
    async refund(p) {
      const d = await call('/refunds', { payment_intent: p.providerPaymentId!, amount: String(p.amountCents) }, p.idempotencyKey);
      return { providerRef: d.id };
    },
  };
}

// ---------------- Razorpay (Payment Links) ----------------
export function razorpayAdapter(keyId: string, keySecret: string, webhookSecret: string): PaymentAdapter {
  // Razorpay has no idempotency header; duplicate refunds are prevented by our own Refund ledger
  // (a row is written before the provider call) and the `receipt` field makes retries traceable.
  const call = async (path: string, body: unknown, _idem: string) => {
    const r = await fetch(`https://api.razorpay.com/v1${path}`, {
      method: 'POST',
      headers: { Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const d: any = await r.json();
    if (!r.ok) throw new HttpError(502, d?.error?.description ?? 'Payment provider error', 'provider_error');
    return d;
  };
  return {
    name: 'razorpay',
    async createCheckout(i) {
      const d = await call('/payment_links', {
        amount: i.amountCents, currency: i.currency, description: i.description, reference_id: i.paymentId,
        customer: { name: i.customer.name, contact: i.customer.phone }, callback_url: i.returnUrl, callback_method: 'get',
      }, `link-${i.paymentId}`);
      return { providerRef: d.id, url: d.short_url };
    },
    parseWebhook(raw, headers) {
      const sig = header(headers, 'x-razorpay-signature') ?? '';
      if (!safeEqual(hmac(webhookSecret, raw), sig)) throw bad();
      const ev = JSON.parse(raw.toString('utf8'));
      const link = ev.payload?.payment_link?.entity;
      const eventId = header(headers, 'x-razorpay-event-id') ?? '';
      if (!eventId) throw bad();
      if (ev.event === 'payment_link.paid')
        return { eventId, kind: 'paid', providerRef: link.id, providerPaymentId: ev.payload?.payment?.entity?.id, amountCents: link.amount_paid };
      if (ev.event === 'payment_link.expired' || ev.event === 'payment_link.cancelled') return { eventId, kind: 'failed', providerRef: link.id };
      return null;
    },
    async refund(p) {
      const d = await call(`/payments/${p.providerPaymentId}/refund`, { amount: p.amountCents, receipt: p.idempotencyKey, notes: { paymentId: p.paymentId } }, p.idempotencyKey);
      return { providerRef: d.id };
    },
  };
}

// ---------------- Test provider (never available in production) ----------------
// Lets developers exercise the full pay / webhook / refund path without real credentials.
// "Paying" happens on /pay/test/:id and is delivered through the same signed-webhook code path.
export const TEST_SECRET = crypto.createHash('sha256').update(`test-provider:${env.jwtSecret}`).digest('hex');
export function testAdapter(): PaymentAdapter {
  return {
    name: 'test',
    async createCheckout(i) {
      const ref = `test_${i.paymentId}`;
      return { providerRef: ref, url: `${env.webOrigin}/pay/test/${i.paymentId}` };
    },
    parseWebhook(raw, headers) {
      if (!safeEqual(hmac(TEST_SECRET, raw), header(headers, 'x-test-signature') ?? '')) throw bad();
      const ev = JSON.parse(raw.toString('utf8'));
      return ev as PaymentEvent;
    },
    async refund(p) { return { providerRef: `test_refund_${p.idempotencyKey}` }; },
  };
}
export const signTestEvent = (raw: string) => hmac(TEST_SECRET, raw);

/** Adapters actually configured on this server. Each requires its own credentials. */
export function configuredAdapters(): Record<string, PaymentAdapter> {
  const e = process.env;
  const out: Record<string, PaymentAdapter> = {};
  if (e.STRIPE_SECRET_KEY && e.STRIPE_WEBHOOK_SECRET) out.stripe = stripeAdapter(e.STRIPE_SECRET_KEY, e.STRIPE_WEBHOOK_SECRET);
  if (e.RAZORPAY_KEY_ID && e.RAZORPAY_KEY_SECRET && e.RAZORPAY_WEBHOOK_SECRET)
    out.razorpay = razorpayAdapter(e.RAZORPAY_KEY_ID, e.RAZORPAY_KEY_SECRET, e.RAZORPAY_WEBHOOK_SECRET);
  if (!env.isProd && e.ENABLE_TEST_PAYMENTS === '1') out.test = testAdapter();
  return out;
}

/** The provider used for new checkouts: PAYMENT_PROVIDER if configured, otherwise the first configured one. */
export function activeAdapter(): PaymentAdapter | null {
  const all = configuredAdapters();
  return all[process.env.PAYMENT_PROVIDER ?? ''] ?? Object.values(all)[0] ?? null;
}
