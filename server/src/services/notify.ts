import { prisma } from '../db.js';
import { logger } from '../lib/logger.js';
import { broadcast } from '../lib/events.js';
import { sendEmail, sendSms, sendWhatsApp } from './integrations.js';

export const DEFAULT_TEMPLATES: Record<string, { subject: string; body: string }> = {
  'order.placed': { subject: 'We received your order #{{number}}', body: 'Hi {{name}}, thanks for ordering from The Minerva. Order #{{number}} ({{total}}). Track it: {{trackUrl}}' },
  'order.accepted': { subject: 'Order #{{number}} accepted', body: 'Hi {{name}}, your order #{{number}} has been accepted. Track: {{trackUrl}}' },
  'order.preparing': { subject: 'Order #{{number}} is being prepared', body: 'Your order #{{number}} is now being prepared.' },
  'order.ready': { subject: 'Order #{{number}} is ready', body: 'Your order #{{number}} is ready.' },
  'order.out_for_delivery': { subject: 'Order #{{number}} is on its way', body: 'Your order #{{number}} is out for delivery. Track: {{trackUrl}}' },
  'order.completed': { subject: 'Order #{{number}} completed', body: 'Order #{{number}} is complete. Thank you for dining with The Minerva!' },
  'order.rejected': { subject: 'Order #{{number}} could not be accepted', body: 'Sorry {{name}}, we could not accept order #{{number}}. {{reason}}' },
  'order.cancelled': { subject: 'Order #{{number}} cancelled', body: 'Order #{{number}} has been cancelled.' },
  'payment.confirmed': { subject: 'Payment received for #{{number}}', body: 'We received your payment of {{amount}} for order #{{number}}.' },
  'refund.confirmed': { subject: 'Refund issued for #{{number}}', body: 'We refunded {{amount}} for order #{{number}}.' },
  'reservation.confirmed': { subject: 'Reservation {{reference}} confirmed', body: 'Hi {{name}}, your table for {{guests}} on {{when}} is confirmed. Ref {{reference}}.' },
  'reservation.cancelled': { subject: 'Reservation {{reference}} cancelled', body: 'Your reservation {{reference}} has been cancelled.' },
  'reservation.reminder': { subject: 'Reminder: reservation {{reference}}', body: 'Reminder: table for {{guests}} on {{when}}. Ref {{reference}}.' },
  'loyalty.reward': { subject: 'You earned {{points}} points', body: 'Hi {{name}}, you earned {{points}} loyalty points. Balance: {{balance}}.' },
  'password.reset': { subject: 'Reset your password', body: 'Use this link to reset your password (valid 1 hour): {{link}}' },
};

const render = (tpl: string, vars: Record<string, unknown>) =>
  tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => String(vars[k] ?? ''));

export interface Recipient { email?: string | null; phone?: string | null; name?: string | null }

/** Transactional notification. Writes a delivery log row per attempt; never throws to callers. */
export async function notify(event: string, to: Recipient, vars: Record<string, unknown> = {}) {
  try {
    const custom = await prisma.notificationTemplate.findMany({ where: { key: event } });
    const base = DEFAULT_TEMPLATES[event];
    if (!base && !custom.length) return;
    const v = { name: to.name ?? 'there', ...vars };
    const pick = (ch: string) => custom.find((c) => c.channel === ch);
    const subject = render(pick('EMAIL')?.subject ?? base?.subject ?? event, v);
    const body = (ch: string) => render(pick(ch)?.body ?? base?.body ?? '', v);

    const jobs: Array<Promise<void>> = [];
    const attempt = async (channel: 'EMAIL' | 'WHATSAPP' | 'SMS', recipient: string, run: () => Promise<{ ok: boolean; skipped?: boolean; error?: string }>) => {
      const text = body(channel);
      const r = await run();
      await prisma.notificationLog.create({
        data: { channel, event, recipient, subject, body: text, status: r.ok ? 'SENT' : r.skipped ? 'SKIPPED' : 'FAILED', error: r.error },
      });
    };
    if (to.email) jobs.push(attempt('EMAIL', to.email, () => sendEmail(to.email!, subject, body('EMAIL'))));
    if (to.phone) {
      jobs.push(attempt('WHATSAPP', to.phone, () => sendWhatsApp(to.phone!, body('WHATSAPP'))));
    }
    await Promise.all(jobs);
  } catch (e) {
    logger.error({ err: e, event }, 'notify failed');
  }
}

export async function notifySms(event: string, phone: string, text: string) {
  const r = await sendSms(phone, text);
  await prisma.notificationLog.create({ data: { channel: 'SMS', event, recipient: phone, body: text, status: r.ok ? 'SENT' : r.skipped ? 'SKIPPED' : 'FAILED', error: r.error } });
}

/** In-app staff alert (shown in the dashboard + pushed over WebSocket). */
export async function staffAlert(type: string, message: string) {
  const row = await prisma.staffNotification.create({ data: { type, message } });
  broadcast('staff', 'alert', row);
  return row;
}
