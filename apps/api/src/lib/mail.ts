import { env } from './core';
import { messageAdapters } from './messaging';

/**
 * Sends a system email (password reset, verification, security notices) through the configured email provider.
 * Never throws: callers must not leak whether an address exists, and a mail outage must not break the request.
 * Returns whether the provider accepted the message.
 */
export async function sendMail(to: string, subject: string, text: string): Promise<boolean> {
  const adapter = messageAdapters().EMAIL;
  if (!adapter) {
    console.error(JSON.stringify({ event: 'mail.not_configured', subject })); // in production this means resets and verification cannot work
    return false;
  }
  try {
    await adapter.send({ to, name: to, subject, text });
    // The development "test" provider contacts nobody. Print the message so a developer can follow the link.
    if (adapter.name === 'test' && !env.isProd && process.env.NODE_ENV !== 'test') console.log(JSON.stringify({ event: 'dev.email', to, subject, text }));
    return true;
  } catch (e) {
    console.error(JSON.stringify({ event: 'mail.failed', subject, error: e instanceof Error ? e.message : String(e) }));
    return false;
  }
}

export const webLink = (path: string, params: Record<string, string>) => `${env.webOrigin}${path}?${new URLSearchParams(params).toString()}`;
