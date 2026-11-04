import crypto from 'node:crypto';
import { hashToken, prisma } from './core';
import { sendMail, webLink } from './mail';

type Purpose = 'PASSWORD_RESET' | 'EMAIL_VERIFY';
const TTL: Record<Purpose, number> = { PASSWORD_RESET: 30 * 60_000, EMAIL_VERIFY: 24 * 3_600_000 };
const HOURLY_CAP = 3; // per account and purpose, so a form cannot be used to flood someone's inbox

/** Creates a single-use link token. Only its SHA-256 hash is stored. Returns null when the hourly cap is reached. */
export async function createToken(userId: string, purpose: Purpose): Promise<string | null> {
  const recent = await prisma.authToken.count({ where: { userId, purpose, createdAt: { gt: new Date(Date.now() - 3_600_000) } } });
  if (recent >= HOURLY_CAP) return null;
  const raw = crypto.randomBytes(32).toString('base64url');
  await prisma.authToken.create({ data: { userId, purpose, tokenHash: hashToken(raw), expiresAt: new Date(Date.now() + TTL[purpose]) } });
  return raw;
}

/** Marks a token used exactly once. Returns the owning user, or null if the token is unknown, used, expired or the wrong kind. */
export async function consumeToken(raw: string, purpose: Purpose) {
  const row = await prisma.authToken.findUnique({ where: { tokenHash: hashToken(raw) }, include: { user: true } });
  if (!row || row.purpose !== purpose || row.usedAt || row.expiresAt < new Date()) return null;
  const claimed = await prisma.authToken.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: new Date() } }); // two clicks at once: only one wins
  return claimed.count ? row.user : null;
}

export async function sendVerificationEmail(user: { id: string; email: string; name: string }) {
  const raw = await createToken(user.id, 'EMAIL_VERIFY');
  if (!raw) return false;
  const link = webLink('/verify-email', { token: raw });
  return sendMail(user.email, 'Confirm your email address', `Hi ${user.name.split(' ')[0]},\n\nConfirm your email address for The Minerva:\n${link}\n\nThe link works once and expires in 24 hours. If you did not create an account, ignore this message.`);
}

export async function sendResetEmail(user: { id: string; email: string; name: string }) {
  const raw = await createToken(user.id, 'PASSWORD_RESET');
  if (!raw) return false;
  const link = webLink('/reset-password', { token: raw });
  return sendMail(user.email, 'Reset your password for The Minerva', `Hi ${user.name.split(' ')[0]},\n\nSomeone (hopefully you) asked to reset your password:\n${link}\n\nThe link works once and expires in 30 minutes. If it was not you, ignore this message: your password has not changed.`);
}

export const sendSecurityNotice = (to: string, what: string) =>
  sendMail(to, 'Security notice for your account at The Minerva', `${what}\n\nIf this was not you, reset your password immediately and contact support.`);
