import { config } from '../config.js';

export interface SendResult { ok: boolean; skipped?: boolean; error?: string }

async function post(url: string, init: RequestInit): Promise<SendResult> {
  try {
    const r = await fetch(url, init);
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}: ${(await r.text()).slice(0, 200)}` };
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

export const emailConfigured = () => !!(config.RESEND_API_KEY && config.EMAIL_FROM);
export const whatsappConfigured = () => !!(config.WHATSAPP_TOKEN && config.WHATSAPP_PHONE_ID);
export const smsConfigured = () => !!(config.TWILIO_SID && config.TWILIO_TOKEN && config.TWILIO_FROM);

export async function sendEmail(to: string, subject: string, text: string): Promise<SendResult> {
  if (!emailConfigured()) return { ok: false, skipped: true, error: 'Email provider (Resend) not configured' };
  return post('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: config.EMAIL_FROM, to: [to], subject, text }),
  });
}

/** Meta WhatsApp Cloud API. Free-form text only works inside a 24h customer window; approved templates are needed otherwise. */
export async function sendWhatsApp(to: string, text: string): Promise<SendResult> {
  if (!whatsappConfigured()) return { ok: false, skipped: true, error: 'WhatsApp Cloud API not configured' };
  return post(`https://graph.facebook.com/v20.0/${config.WHATSAPP_PHONE_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to: to.replace(/\D/g, ''), type: 'text', text: { body: text } }),
  });
}

export async function sendSms(to: string, text: string): Promise<SendResult> {
  if (!smsConfigured()) return { ok: false, skipped: true, error: 'SMS provider (Twilio) not configured' };
  const auth = Buffer.from(`${config.TWILIO_SID}:${config.TWILIO_TOKEN}`).toString('base64');
  return post(`https://api.twilio.com/2010-04-01/Accounts/${config.TWILIO_SID}/Messages.json`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ To: to, From: config.TWILIO_FROM!, Body: text }),
  });
}

export function integrationStatus() {
  return {
    email: { provider: 'Resend', configured: emailConfigured(), env: ['RESEND_API_KEY', 'EMAIL_FROM'] },
    whatsapp: { provider: 'Meta WhatsApp Cloud API', configured: whatsappConfigured(), env: ['WHATSAPP_TOKEN', 'WHATSAPP_PHONE_ID'] },
    sms: { provider: 'Twilio', configured: smsConfigured(), env: ['TWILIO_SID', 'TWILIO_TOKEN', 'TWILIO_FROM'] },
    stripe: { provider: 'Stripe', configured: !!config.STRIPE_SECRET_KEY, webhook: !!config.STRIPE_WEBHOOK_SECRET, env: ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'] },
    razorpay: { provider: 'Razorpay', configured: !!(config.RAZORPAY_KEY_ID && config.RAZORPAY_KEY_SECRET), webhook: !!config.RAZORPAY_WEBHOOK_SECRET, env: ['RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET'] },
    ai: { provider: 'Anthropic', configured: !!config.ANTHROPIC_API_KEY, env: ['ANTHROPIC_API_KEY'] },
    storage: { provider: 'AWS S3 + CloudFront', configured: !!(config.S3_BUCKET && config.AWS_REGION), env: ['AWS_REGION', 'S3_BUCKET', 'CDN_URL'], note: 'Without S3, uploads are stored on the server disk (/uploads).' },
    redis: { provider: 'Redis', configured: !!config.REDIS_URL, env: ['REDIS_URL'] },
  };
}
