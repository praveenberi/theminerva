import crypto from 'node:crypto';
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import QRCode from 'qrcode';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import type { User } from '@prisma/client';
import { HttpError, parse, passwordSchema, prisma, verifyMfaToken } from '../lib/core';
import { consumeToken, sendResetEmail, sendSecurityNotice, sendVerificationEmail } from '../lib/accountTokens';
import { randomCode } from '../lib/loyalty';
import { decryptJson, encryptJson } from '../lib/secrets';
import { newSecret, otpauthUri, verifyTotp } from '../lib/totp';
import { authenticate, clearAuthCache, endAllSessions, requireRole, wrap } from '../middleware/auth';
import { LOCK_MINUTES, MAX_FAILED_LOGINS, issue } from './auth';

export const auth2 = Router();

const limiter = rateLimit({ windowMs: 15 * 60_000, limit: Number(process.env.AUTH_RATE_LIMIT ?? 50), standardHeaders: true, legacyHeaders: false });
// anything that sends an email gets a much tighter per-IP budget
const mailLimiter = rateLimit({ windowMs: 60 * 60_000, limit: Number(process.env.MAIL_RATE_LIMIT ?? 10), standardHeaders: true, legacyHeaders: false });

const revokeSessions = endAllSessions;
const userView = (u: User) => ({ id: u.id, name: u.name, email: u.email, role: u.role });

// ---------------------------------------------------------------- password reset
/** Always answers the same, so the form cannot be used to find out which emails have accounts. */
const SAME = { ok: true, message: 'If that email has an account, a reset link is on its way. It works for 30 minutes.' };

auth2.post('/forgot-password', mailLimiter, wrap(async (req, res) => {
  const { email } = parse(z.object({ email: z.string().trim().toLowerCase().email() }), req.body);
  const user = await prisma.user.findUnique({ where: { email } });
  if (user?.active) void sendResetEmail(user); // not awaited: response time must not depend on whether the account exists
  res.json(SAME);
}));

auth2.post('/reset-password', limiter, wrap(async (req, res) => {
  // validated first so a too-weak password does not use up the one-time link
  const d = parse(z.object({ token: z.string().min(20).max(200), password: passwordSchema }), req.body);
  const user = await consumeToken(d.token, 'PASSWORD_RESET');
  if (!user || !user.active) throw new HttpError(400, 'This link is invalid or has expired. Request a new one.', 'invalid_token');
  await prisma.$transaction([
    // clicking a link in the mailbox proves the owner controls the address, so it also verifies it
    prisma.user.update({ where: { id: user.id }, data: { passwordHash: await bcrypt.hash(d.password, 12), failedLogins: 0, lockedUntil: null, tokensValidAfter: new Date(), emailVerifiedAt: user.emailVerifiedAt ?? new Date() } }),
    prisma.refreshToken.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } }),
    prisma.authToken.updateMany({ where: { userId: user.id, purpose: 'PASSWORD_RESET', usedAt: null }, data: { usedAt: new Date() } }), // any other outstanding links die too
  ]);
  clearAuthCache(user.id);
  void sendSecurityNotice(user.email, 'The password on your Tablely account was just changed using a reset link.');
  // MFA, if on, is deliberately untouched: the email alone must not be enough to take over the account
  res.json({ ok: true, mfaRequired: user.mfaEnabled });
}));

// ---------------------------------------------------------------- email verification
auth2.post('/verify-email/request', mailLimiter, authenticate, wrap(async (req, res) => {
  const u = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id } });
  if (u.emailVerifiedAt) return void res.json({ ok: true, alreadyVerified: true });
  await sendVerificationEmail(u);
  res.json({ ok: true });
}));

auth2.post('/verify-email', limiter, wrap(async (req, res) => {
  const { token } = parse(z.object({ token: z.string().min(20).max(200) }), req.body);
  const user = await consumeToken(token, 'EMAIL_VERIFY');
  if (!user) throw new HttpError(400, 'This link is invalid or has expired. Request a new one from Account.', 'invalid_token');
  await prisma.user.update({ where: { id: user.id }, data: { emailVerifiedAt: user.emailVerifiedAt ?? new Date() } });
  clearAuthCache(user.id);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------- MFA
const recoveryHash = (code: string) => crypto.createHash('sha256').update(code.toUpperCase().replace(/[^A-Z0-9]/g, '')).digest('hex');
const newRecoveryCodes = () => Array.from({ length: 10 }, () => { const c = randomCode(10); return `${c.slice(0, 5)}-${c.slice(5)}`; });

/**
 * Checks a TOTP code or a recovery code. A TOTP step is accepted once and never older than the last one used (no replays),
 * and a recovery code is removed atomically so two simultaneous uses cannot both succeed.
 */
async function checkSecondFactor(user: User, input: { code?: string; recoveryCode?: string }): Promise<boolean> {
  if (input.code) {
    if (!user.mfaSecretEnc) return false;
    const step = verifyTotp(decryptJson<{ secret: string }>(user.mfaSecretEnc).secret, input.code);
    if (step == null) return false;
    const claimed = await prisma.user.updateMany({ where: { id: user.id, OR: [{ mfaLastStep: null }, { mfaLastStep: { lt: step } }] }, data: { mfaLastStep: step } });
    return claimed.count === 1;
  }
  if (input.recoveryCode) {
    const h = recoveryHash(input.recoveryCode);
    return (await prisma.$executeRaw`UPDATE "User" SET "recoveryCodes" = array_remove("recoveryCodes", ${h}) WHERE id = ${user.id} AND ${h} = ANY("recoveryCodes")`) === 1;
  }
  return false;
}

async function failedAttempt(userId: string) {
  const n = (await prisma.user.update({ where: { id: userId }, data: { failedLogins: { increment: 1 } }, select: { failedLogins: true } })).failedLogins;
  if (n >= MAX_FAILED_LOGINS) {
    await prisma.user.update({ where: { id: userId }, data: { lockedUntil: new Date(Date.now() + LOCK_MINUTES * 60_000) } });
    console.warn(JSON.stringify({ event: 'auth.account_locked', userId, failures: n, via: 'mfa' }));
  }
}

const secondFactor = z.object({ code: z.string().trim().max(20).optional(), recoveryCode: z.string().trim().max(30).optional() }).refine((x) => !!x.code || !!x.recoveryCode, 'Enter a code');
const passwordIs = async (userId: string, password: string) => {
  const u = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (!(await bcrypt.compare(password, u.passwordHash))) throw new HttpError(401, 'Your password is not correct', 'bad_credentials');
  return u;
};

/** Step 1 of enrolment. Nothing is switched on yet; the secret stays "pending" until a real code proves the app works. */
auth2.post('/mfa/setup', limiter, authenticate, wrap(async (req, res) => {
  const { password } = parse(z.object({ password: z.string().min(1).max(200) }), req.body);
  const u = await passwordIs(req.user!.id, password);
  if (u.mfaEnabled) throw new HttpError(409, 'Two-factor authentication is already on', 'already_enabled');
  const secret = newSecret();
  await prisma.user.update({ where: { id: u.id }, data: { mfaPendingEnc: encryptJson({ secret }) } });
  const uri = otpauthUri(secret, u.email);
  res.json({ secret, otpauthUri: uri, qrSvg: await QRCode.toString(uri, { type: 'svg', margin: 1 }) }); // the only time the secret is shown
}));

auth2.post('/mfa/enable', limiter, authenticate, wrap(async (req, res) => {
  const { code } = parse(z.object({ code: z.string().trim().max(20) }), req.body);
  const u = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id } });
  if (u.mfaEnabled) throw new HttpError(409, 'Two-factor authentication is already on', 'already_enabled');
  if (!u.mfaPendingEnc) throw new HttpError(400, 'Start the setup again', 'validation');
  const step = verifyTotp(decryptJson<{ secret: string }>(u.mfaPendingEnc).secret, code);
  if (step == null) throw new HttpError(400, 'That code is not correct. Check the clock on your phone and try the next code.', 'bad_code');
  const codes = newRecoveryCodes();
  await prisma.user.update({ where: { id: u.id }, data: { mfaEnabled: true, mfaSecretEnc: u.mfaPendingEnc, mfaPendingEnc: null, mfaLastStep: step, recoveryCodes: codes.map(recoveryHash) } });
  await revokeSessions(u.id); // sessions opened without MFA must not outlive turning it on
  clearAuthCache(u.id);
  void sendSecurityNotice(u.email, 'Two-factor authentication was turned on for your Tablely account.');
  res.json({ recoveryCodes: codes, user: userView(u), ...(await issue(u, res)) }); // shown once: only hashes are kept
}));

auth2.post('/mfa/disable', limiter, authenticate, wrap(async (req, res) => {
  const d = parse(secondFactor.and(z.object({ password: z.string().min(1).max(200) })), req.body);
  const u = await passwordIs(req.user!.id, d.password);
  if (!u.mfaEnabled) throw new HttpError(409, 'Two-factor authentication is not on', 'not_enabled');
  if (!(await checkSecondFactor(u, d))) throw new HttpError(401, 'That code is not correct', 'bad_code');
  await prisma.user.update({ where: { id: u.id }, data: { mfaEnabled: false, mfaSecretEnc: null, mfaPendingEnc: null, mfaLastStep: null, recoveryCodes: [] } });
  await revokeSessions(u.id);
  clearAuthCache(u.id);
  void sendSecurityNotice(u.email, 'Two-factor authentication was turned off for your Tablely account.');
  res.json({ ok: true, user: userView(u), ...(await issue(u, res)) });
}));

auth2.post('/mfa/recovery-codes', limiter, authenticate, wrap(async (req, res) => {
  const d = parse(z.object({ password: z.string().min(1).max(200), code: z.string().trim().max(20) }), req.body);
  const u = await passwordIs(req.user!.id, d.password);
  if (!u.mfaEnabled) throw new HttpError(409, 'Two-factor authentication is not on', 'not_enabled');
  if (!(await checkSecondFactor(u, { code: d.code }))) throw new HttpError(401, 'That code is not correct', 'bad_code'); // an authenticator code, not a recovery code
  const codes = newRecoveryCodes();
  await prisma.user.update({ where: { id: u.id }, data: { recoveryCodes: codes.map(recoveryHash) } }); // the old set stops working
  res.json({ recoveryCodes: codes });
}));

/** Step 2 of signing in for accounts with MFA. */
auth2.post('/login/mfa', limiter, wrap(async (req, res) => {
  const d = parse(secondFactor.and(z.object({ mfaToken: z.string().min(10).max(2000) })), req.body);
  let userId: string;
  try { userId = verifyMfaToken(d.mfaToken); } catch { throw new HttpError(401, 'This sign-in expired. Enter your password again.', 'mfa_expired'); }
  const user = await prisma.user.findUnique({ where: { id: userId }, include: { tenant: true } });
  if (!user || !user.active || !user.mfaEnabled || (user.lockedUntil && user.lockedUntil > new Date()))
    throw new HttpError(401, 'Invalid code, or too many attempts. Try again later.', 'bad_credentials');
  if (!(await checkSecondFactor(user, d))) {
    await failedAttempt(user.id);
    throw new HttpError(401, 'That code is not correct', 'bad_code');
  }
  if (user.tenant?.status === 'SUSPENDED') throw new HttpError(403, 'This account is suspended', 'suspended');
  await prisma.user.update({ where: { id: user.id }, data: { failedLogins: 0, lockedUntil: null } });
  res.json({ user: userView(user), recoveryCodesLeft: (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).recoveryCodes.length, ...(await issue(user, res)) });
}));

// ---------------------------------------------------------------- lost-device recovery by someone with authority
async function resetMfa(userId: string, actorId: string, scope: string) {
  const u = await prisma.user.update({ where: { id: userId }, data: { mfaEnabled: false, mfaSecretEnc: null, mfaPendingEnc: null, mfaLastStep: null, recoveryCodes: [] } });
  await revokeSessions(userId);
  clearAuthCache(userId);
  await prisma.auditLog.create({ data: { actorId, action: 'mfa.reset', detail: { userId, by: scope } } });
  void sendSecurityNotice(u.email, 'Two-factor authentication was reset on your Tablely account by an administrator. Set it up again after you sign in.');
}

/** An owner can reset the second factor of their own staff (never of another owner). */
export const staffMfa = Router();
staffMfa.post('/:id/reset-mfa', authenticate, requireRole('OWNER'), wrap(async (req, res) => {
  const target = await prisma.user.findFirst({ where: { id: req.params.id, tenantId: req.user!.tenantId!, role: { not: 'OWNER' } } });
  if (!target) throw new HttpError(404, 'Not found', 'not_found');
  await resetMfa(target.id, req.user!.id, 'owner');
  res.json({ ok: true });
}));

/** The platform admin can reset anyone's (for an owner who lost both phone and recovery codes). Audited and emailed. */
export const adminMfa = Router();
adminMfa.post('/reset-mfa', authenticate, requireRole('SUPER_ADMIN'), wrap(async (req, res) => {
  const { email } = parse(z.object({ email: z.string().trim().toLowerCase().email() }), req.body);
  const target = await prisma.user.findUnique({ where: { email } });
  if (!target || target.id === req.user!.id) throw new HttpError(404, 'No other account has that email', 'not_found');
  await resetMfa(target.id, req.user!.id, 'platform');
  res.json({ ok: true });
}));

