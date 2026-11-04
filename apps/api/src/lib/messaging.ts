import { HttpError, env } from './core';

export type Channel = 'EMAIL' | 'WHATSAPP';
export interface Outgoing { to: string; name: string; subject?: string; text: string }
export interface MessageAdapter {
  name: string;
  channel: Channel;
  /** Resolves only when the provider accepted the message; throws otherwise. */
  send(m: Outgoing): Promise<{ providerRef: string }>;
}

/** Records messages in memory; never contacts anyone. Dev/test only (ENABLE_TEST_MESSAGING=1, ignored in production). */
export const testOutbox: (Outgoing & { channel: Channel })[] = [];
const testAdapter = (channel: Channel): MessageAdapter => ({
  name: 'test', channel,
  async send(m) {
    if (m.to.includes('fail')) throw new Error('Simulated provider rejection');
    testOutbox.push({ ...m, channel });
    return { providerRef: `test-${testOutbox.length}` };
  },
});

/** Email through Resend's HTTP API. Needs RESEND_API_KEY and EMAIL_FROM (a verified sender). */
const resendAdapter = (key: string, from: string): MessageAdapter => ({
  name: 'resend', channel: 'EMAIL',
  async send(m) {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [m.to], subject: m.subject ?? 'A message from us', text: m.text }),
    });
    const d: any = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d?.message ?? `Resend error ${r.status}`);
    return { providerRef: d.id };
  },
});

/**
 * WhatsApp Cloud API. Business-initiated marketing must use a pre-approved *template*, so this sends the template
 * named in WHATSAPP_TEMPLATE with two body variables: {{1}} = customer name, {{2}} = message text.
 */
const whatsappAdapter = (token: string, phoneId: string, template: string, lang: string): MessageAdapter => ({
  name: 'whatsapp-cloud', channel: 'WHATSAPP',
  async send(m) {
    const r = await fetch(`https://graph.facebook.com/v20.0/${phoneId}/messages`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp', to: m.to.replace(/\D/g, ''), type: 'template',
        template: { name: template, language: { code: lang }, components: [{ type: 'body', parameters: [{ type: 'text', text: m.name }, { type: 'text', text: m.text.replace(/\s*\n+\s*/g, ' ') }] }] },
      }),
    });
    const d: any = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d?.error?.message ?? `WhatsApp error ${r.status}`);
    return { providerRef: d.messages?.[0]?.id ?? 'unknown' };
  },
});

export function messageAdapters(): Partial<Record<Channel, MessageAdapter>> {
  const e = process.env;
  const out: Partial<Record<Channel, MessageAdapter>> = {};
  if (e.RESEND_API_KEY && e.EMAIL_FROM) out.EMAIL = resendAdapter(e.RESEND_API_KEY, e.EMAIL_FROM);
  if (e.WHATSAPP_TOKEN && e.WHATSAPP_PHONE_ID && e.WHATSAPP_TEMPLATE) out.WHATSAPP = whatsappAdapter(e.WHATSAPP_TOKEN, e.WHATSAPP_PHONE_ID, e.WHATSAPP_TEMPLATE, e.WHATSAPP_LANG ?? 'en');
  if (!env.isProd && e.ENABLE_TEST_MESSAGING === '1') {
    out.EMAIL ??= testAdapter('EMAIL');
    out.WHATSAPP ??= testAdapter('WHATSAPP');
  }
  return out;
}

export function adapterFor(channel: Channel): MessageAdapter {
  const a = messageAdapters()[channel];
  if (!a) throw new HttpError(409, `${channel === 'EMAIL' ? 'Email' : 'WhatsApp'} sending is not configured on this server`, 'channel_unavailable');
  return a;
}
