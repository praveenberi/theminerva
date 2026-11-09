import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { prisma } from '../db.js';
import { config } from '../config.js';
import {
  REFRESH_COOKIE, attachAuth, clearRefresh, hashPassword, issueRefresh, randomToken, requireStaff, sha256, signAccess, verifyPassword,
} from '../lib/auth.js';
import { ApiError, badRequest, parse, unauthorized, wrap } from '../lib/http.js';
import { permsFor } from '../lib/permissions.js';
import { audit } from '../lib/audit.js';
import { notify } from '../services/notify.js';
import { getSettings } from '../lib/settings.js';

export const authRouter = Router();
const strict = rateLimit({ windowMs: 15 * 60_000, limit: process.env.NODE_ENV === 'test' ? 10_000 : 20, standardHeaders: true, legacyHeaders: false, message: { error: { code: 'RATE_LIMITED', message: 'Too many attempts. Try again in a few minutes.' } } });

const password = z.string().min(10, 'Use at least 10 characters').max(128)
  .regex(/[a-z]/, 'Include a lowercase letter').regex(/[A-Z]/, 'Include an uppercase letter').regex(/\d/, 'Include a number');
const phone = z.string().trim().regex(/^\+?[0-9 ()-]{7,20}$/, 'Enter a valid phone number');

authRouter.post('/register', strict, wrap(async (req, res) => {
  const b = parse(z.object({
    name: z.string().trim().min(2).max(80), email: z.string().trim().toLowerCase().email(), phone: phone.optional(),
    password, referralCode: z.string().trim().optional(), marketingConsent: z.boolean().default(false),
  }), req.body);
  const exists = await prisma.customer.findFirst({ where: { OR: [{ email: b.email }, ...(b.phone ? [{ phone: b.phone }] : [])] } });
  if (exists && exists.passwordHash) throw new ApiError(409, 'EMAIL_TAKEN', 'An account with this email or phone already exists');
  const referrer = b.referralCode ? await prisma.customer.findUnique({ where: { referralCode: b.referralCode } }) : null;
  const data = {
    name: b.name, email: b.email, phone: b.phone, passwordHash: await hashPassword(b.password),
    marketingConsent: b.marketingConsent, consentAt: b.marketingConsent ? new Date() : null,
    referredById: referrer && referrer.id !== exists?.id ? referrer.id : undefined,
  };
  // a guest customer row created by an earlier order is claimed rather than duplicated
  const c = exists ? await prisma.customer.update({ where: { id: exists.id }, data }) : await prisma.customer.create({ data });
  await issueRefresh(res, { customerId: c.id });
  res.status(201).json({ accessToken: signAccess({ kind: 'customer', id: c.id, name: c.name }), user: { kind: 'customer', id: c.id, name: c.name, email: c.email } });
}));

authRouter.post('/login', strict, wrap(async (req, res) => {
  const b = parse(z.object({ email: z.string().trim().toLowerCase().email(), password: z.string().min(1) }), req.body);
  const staff = await prisma.user.findUnique({ where: { email: b.email } });
  if (staff) {
    // constant-ish behaviour: always hash-compare
    const ok = staff.isActive && (await verifyPassword(b.password, staff.passwordHash));
    if (!ok) { await audit(req, 'auth.login_failed', 'User', staff.id); throw unauthorized('Incorrect email or password'); }
    await prisma.user.update({ where: { id: staff.id }, data: { lastLoginAt: new Date() } });
    await issueRefresh(res, { staffId: staff.id });
    await audit({ staff: { id: staff.id }, ip: req.ip } as any, 'auth.login', 'User', staff.id);
    return res.json({
      accessToken: signAccess({ kind: 'staff', id: staff.id, role: staff.role, name: staff.name, email: staff.email }),
      user: { kind: 'staff', id: staff.id, name: staff.name, email: staff.email, role: staff.role, permissions: permsFor(staff.role) },
    });
  }
  const c = await prisma.customer.findUnique({ where: { email: b.email } });
  if (!c?.passwordHash || !(await verifyPassword(b.password, c.passwordHash))) throw unauthorized('Incorrect email or password');
  await issueRefresh(res, { customerId: c.id });
  res.json({ accessToken: signAccess({ kind: 'customer', id: c.id, name: c.name }), user: { kind: 'customer', id: c.id, name: c.name, email: c.email } });
}));

authRouter.post('/refresh', wrap(async (req, res) => {
  // cookie is SameSite=Strict; the custom header additionally blocks cross-site form posts (CSRF)
  if (req.headers['x-requested-with'] !== 'minerva') throw unauthorized('Missing CSRF header');
  const token = req.cookies?.[REFRESH_COOKIE];
  if (!token) throw unauthorized('No session');
  const hash = sha256(token);
  const st = await prisma.refreshToken.findUnique({ where: { tokenHash: hash }, include: { user: true } });
  if (st) {
    if (st.revokedAt || st.expiresAt < new Date() || !st.user.isActive) {
      // reuse of a revoked token → assume theft, kill all sessions for this user
      if (st.revokedAt) await prisma.refreshToken.updateMany({ where: { userId: st.userId, revokedAt: null }, data: { revokedAt: new Date() } });
      clearRefresh(res); throw unauthorized('Session expired');
    }
    await prisma.refreshToken.update({ where: { id: st.id }, data: { revokedAt: new Date() } });
    await issueRefresh(res, { staffId: st.userId });
    const u = st.user;
    return res.json({
      accessToken: signAccess({ kind: 'staff', id: u.id, role: u.role, name: u.name, email: u.email }),
      user: { kind: 'staff', id: u.id, name: u.name, email: u.email, role: u.role, permissions: permsFor(u.role) },
    });
  }
  const ct = await prisma.customerRefreshToken.findUnique({ where: { tokenHash: hash }, include: { customer: true } });
  if (!ct || ct.revokedAt || ct.expiresAt < new Date()) { clearRefresh(res); throw unauthorized('Session expired'); }
  await prisma.customerRefreshToken.update({ where: { id: ct.id }, data: { revokedAt: new Date() } });
  await issueRefresh(res, { customerId: ct.customerId });
  res.json({ accessToken: signAccess({ kind: 'customer', id: ct.customerId, name: ct.customer.name }), user: { kind: 'customer', id: ct.customerId, name: ct.customer.name, email: ct.customer.email } });
}));

authRouter.post('/logout', wrap(async (req, res) => {
  const token = req.cookies?.[REFRESH_COOKIE];
  if (token) {
    const h = sha256(token);
    await prisma.refreshToken.updateMany({ where: { tokenHash: h }, data: { revokedAt: new Date() } });
    await prisma.customerRefreshToken.updateMany({ where: { tokenHash: h }, data: { revokedAt: new Date() } });
  }
  clearRefresh(res);
  res.json({ ok: true });
}));

authRouter.post('/forgot-password', strict, wrap(async (req, res) => {
  const { email } = parse(z.object({ email: z.string().trim().toLowerCase().email() }), req.body);
  const staff = await prisma.user.findUnique({ where: { email } });
  if (staff) {
    const t = randomToken();
    await prisma.passwordReset.create({ data: { userId: staff.id, tokenHash: sha256(t), expiresAt: new Date(Date.now() + 3600_000) } });
    void notify('password.reset', { email, name: staff.name }, { link: `${config.PUBLIC_WEB_URL}/reset-password?token=${t}` });
  }
  // same answer whether or not the account exists (no user enumeration)
  res.json({ ok: true, message: 'If that email is registered, a reset link has been sent.' });
}));

authRouter.post('/reset-password', strict, wrap(async (req, res) => {
  const b = parse(z.object({ token: z.string().min(10), password }), req.body);
  const r = await prisma.passwordReset.findUnique({ where: { tokenHash: sha256(b.token) } });
  if (!r || r.usedAt || r.expiresAt < new Date()) throw badRequest('This reset link is invalid or has expired');
  await prisma.$transaction([
    prisma.user.update({ where: { id: r.userId }, data: { passwordHash: await hashPassword(b.password) } }),
    prisma.passwordReset.update({ where: { id: r.id }, data: { usedAt: new Date() } }),
    prisma.refreshToken.updateMany({ where: { userId: r.userId, revokedAt: null }, data: { revokedAt: new Date() } }),
  ]);
  res.json({ ok: true });
}));

authRouter.get('/me', attachAuth, wrap(async (req, res) => {
  if (req.staff) return res.json({ ...req.staff, permissions: permsFor(req.staff.role) });
  if (req.customer) return res.json({ ...req.customer });
  throw unauthorized();
}));

void requireStaff; void getSettings;
