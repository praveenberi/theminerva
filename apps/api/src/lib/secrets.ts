import crypto from 'node:crypto';
import { env } from './core';

/**
 * Encrypts small JSON secrets (payment-provider keys) with AES-256-GCM before they touch the database.
 * The key comes from SECRETS_KEY (required in production). In development it is derived from JWT_SECRET so the
 * app works out of the box, but data encrypted that way is only as safe as that development secret.
 * There is no key rotation yet: changing SECRETS_KEY makes existing stored secrets unreadable, so keep it stable and backed up.
 */
function key(): Buffer {
  const k = process.env.SECRETS_KEY;
  if (k) {
    if (k.length < 32) throw new Error('SECRETS_KEY must be at least 32 characters');
    return crypto.createHash('sha256').update(k).digest();
  }
  if (env.isProd) throw new Error('SECRETS_KEY must be set in production');
  return crypto.createHash('sha256').update(`dev-secrets:${env.jwtSecret}`).digest();
}

export function encryptJson(value: unknown): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([c.update(JSON.stringify(value), 'utf8'), c.final()]);
  return `v1.${Buffer.concat([iv, c.getAuthTag(), body]).toString('base64url')}`;
}

export function decryptJson<T>(blob: string): T {
  if (!blob.startsWith('v1.')) throw new Error('Unsupported secret format');
  const raw = Buffer.from(blob.slice(3), 'base64url');
  const d = crypto.createDecipheriv('aes-256-gcm', key(), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8')) as T; // throws if tampered with
}
