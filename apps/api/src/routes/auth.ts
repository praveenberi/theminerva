import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { HttpError, env, hashToken, newRefreshToken, parse, passwordSchema, prisma, signAccess, signMfaToken, slugify } from '../lib/core';
import { sendVerificationEmail } from '../lib/accountTokens';
import { authenticate, clearAuthCache, endAllSessions, requireRole, rid, sameOriginOnly, wrap } from '../middleware/auth';
import { assertWithin, getEntitlements, startTrial } from '../lib/billing';

export const auth = Router();

const limiter = rateLimit({ windowMs: 15 * 60_000, limit: Number(process.env.AUTH_RATE_LIMIT ?? 50), standardHeaders: true, legacyHeaders: false });
const REFRESH_DAYS = 30;

const cookieOpts = {
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: env.isProd,
  path: '/api/auth',
  maxAge: REFRESH_DAYS * 86_400_000,
};

/**
 * Which outlet a session starts in: staff are pinned to their assigned outlet; owners get the outlet they last
 * switched to (remembered on the refresh token) if it still belongs to their tenant, else the oldest one.
 */
async function pickRestaurant(user: { tenantId: string | null; restaurantId?: string | null }, preferred?: string | null) {
  if (!user.tenantId) return null;
  const wanted = user.restaurantId ?? preferred;
  if (wanted) {
    const r = await prisma.restaurant.findFirst({ where: { id: wanted, tenantId: user.tenantId } });
    if (r) return r;
  }
  return prisma.restaurant.findFirst({ where: { tenantId: user.tenantId }, orderBy: { createdAt: 'asc' } });
}

export async function issue(user: { id: string; role: any; tenantId: string | null; restaurantId?: string | null }, res: any, preferred?: string | null) {
  const restaurant = await pickRestaurant(user, preferred);
  const token = newRefreshToken();
  await prisma.refreshToken.create({
    data: { userId: user.id, tokenHash: hashToken(token), restaurantId: restaurant?.id, expiresAt: new Date(Date.now() + REFRESH_DAYS * 86_400_000) },
  });
  res.cookie('rt', token, cookieOpts);
  const accessToken = signAccess({
    id: user.id,
    role: user.role,
    tenantId: user.tenantId,
    restaurantId: restaurant?.id ?? null,
  });
  return { accessToken, restaurant: restaurant && { id: restaurant.id, slug: restaurant.slug, name: restaurant.name } };
}

const registerSchema = z.object({
  restaurantName: z.string().trim().min(2).max(80),
  name: z.string().trim().min(2).max(80),
  email: z.string().trim().toLowerCase().email(),
  password: passwordSchema,
  phone: z.string().trim().max(30).optional(),
  category: z.string().trim().max(40).optional(),
  planCode: z.string().trim().max(20).optional(), // plan to trial; defaults to DEFAULT_PLAN_CODE
});

auth.post(
  '/register',
  limiter,
  wrap(async (req, res) => {
    const d = parse(registerSchema, req.body);
    if (await prisma.user.findUnique({ where: { email: d.email } }))
      throw new HttpError(409, 'An account with this email already exists', 'email_taken');
    const base = slugify(d.restaurantName);
    let slug = base;
    for (let i = 2; await prisma.restaurant.findUnique({ where: { slug } }); i++) slug = `${base}-${i}`;
    const passwordHash = await bcrypt.hash(d.password, 12);
    const user = await prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.create({ data: { name: d.restaurantName } });
      await startTrial(tx, tenant.id, d.planCode);
      await tx.restaurant.create({
        data: { tenantId: tenant.id, slug, name: d.restaurantName, phone: d.phone ?? '', category: d.category ?? 'Restaurant' },
      });
      return tx.user.create({ data: { tenantId: tenant.id, email: d.email, passwordHash, name: d.name, role: 'OWNER' } });
    });
    void sendVerificationEmail(user); // not awaited: a slow mail provider must not slow or break sign-up
    res.status(201).json({ user: { id: user.id, name: user.name, email: user.email, role: user.role }, ...(await issue(user, res)) });
  }),
);

auth.post(
  '/login',
  limiter,
  wrap(async (req, res) => {
    const d = parse(z.object({ email: z.string().trim().toLowerCase().email(), password: z.string().min(1) }), req.body);
    const user = await prisma.user.findUnique({ where: { email: d.email }, include: { tenant: true } });
    // Always spend the same time hashing, whether or not the account exists or is locked, so response time reveals nothing.
    const matches = await bcrypt.compare(d.password, user?.passwordHash ?? (await dummyHash()));
    const locked = !!user?.lockedUntil && user.lockedUntil > new Date();
    if (!user || !user.active || locked || !matches) {
      if (user && !locked) {
        const n = (await prisma.user.update({ where: { id: user.id }, data: { failedLogins: { increment: 1 } }, select: { failedLogins: true } })).failedLogins;
        if (n >= MAX_FAILED_LOGINS) {
          await prisma.user.update({ where: { id: user.id }, data: { lockedUntil: new Date(Date.now() + LOCK_MINUTES * 60_000) } });
          console.warn(JSON.stringify({ event: 'auth.account_locked', userId: user.id, failures: n })); // worth alerting on
        }
      }
      // one generic answer for wrong password, unknown account and locked account
      throw new HttpError(401, 'Invalid email or password, or too many attempts. Try again later.', 'bad_credentials');
    }
    if (user.tenant?.status === 'SUSPENDED') throw new HttpError(403, 'This account is suspended', 'suspended');
    // With MFA on, a correct password only earns a 5-minute pass to the second step. Failure counters are cleared by the full login, not here,
    // so someone who knows the password still cannot guess the code forever.
    if (user.mfaEnabled) return void res.json({ mfaRequired: true, mfaToken: signMfaToken(user.id) });
    if (user.failedLogins || user.lockedUntil) await prisma.user.update({ where: { id: user.id }, data: { failedLogins: 0, lockedUntil: null } });
    res.json({ user: { id: user.id, name: user.name, email: user.email, role: user.role }, ...(await issue(user, res)) });
  }),
);

auth.post(
  '/refresh',
  sameOriginOnly,
  wrap(async (req, res) => {
    const raw = req.cookies?.rt as string | undefined;
    if (!raw) throw new HttpError(401, 'No session', 'unauthenticated');
    const row = await prisma.refreshToken.findUnique({ where: { tokenHash: hashToken(raw) }, include: { user: { include: { tenant: true } } } });
    if (row?.revokedAt && Date.now() - row.revokedAt.getTime() > REUSE_LEEWAY_MS) {
      // A token that was already rotated is being presented again: either it was stolen or the client is broken.
      // Either way, end every session of this user. (The short leeway lets two tabs refreshing at once through.)
      await prisma.refreshToken.updateMany({ where: { userId: row.userId, revokedAt: null }, data: { revokedAt: new Date() } });
      console.warn(JSON.stringify({ event: 'auth.refresh_reuse', userId: row.userId }));
    }
    if (!row || row.revokedAt || row.expiresAt < new Date() || !row.user.active)
      throw new HttpError(401, 'Session expired', 'unauthenticated');
    if (row.user.tenant?.status === 'SUSPENDED') throw new HttpError(403, 'This account is suspended', 'suspended');
    // rotate: revoke the used token and issue a new one
    await prisma.refreshToken.update({ where: { id: row.id }, data: { revokedAt: new Date() } });
    const u = row.user;
    res.json({ user: { id: u.id, name: u.name, email: u.email, role: u.role }, ...(await issue(u, res, row.restaurantId)) });
  }),
);

/** Owners move between the outlets of their own tenant; the choice survives token refreshes. */
auth.post(
  '/switch-outlet',
  sameOriginOnly,
  authenticate,
  requireRole('OWNER'),
  wrap(async (req, res) => {
    const { restaurantId } = parse(z.object({ restaurantId: z.string() }), req.body);
    const r = await prisma.restaurant.findFirst({ where: { id: restaurantId, tenantId: req.user!.tenantId! } });
    if (!r) throw new HttpError(404, 'Outlet not found', 'not_found');
    const raw = req.cookies?.rt as string | undefined;
    if (raw) await prisma.refreshToken.updateMany({ where: { tokenHash: hashToken(raw), userId: req.user!.id }, data: { restaurantId: r.id } });
    res.json({
      accessToken: signAccess({ id: req.user!.id, role: req.user!.role, tenantId: req.user!.tenantId, restaurantId: r.id }),
      restaurant: { id: r.id, slug: r.slug, name: r.name },
    });
  }),
);

auth.post(
  '/logout',
  sameOriginOnly,
  wrap(async (req, res) => {
    const raw = req.cookies?.rt as string | undefined;
    if (raw) await prisma.refreshToken.updateMany({ where: { tokenHash: hashToken(raw) }, data: { revokedAt: new Date() } });
    res.clearCookie('rt', { path: '/api/auth' });
    res.status(204).end();
  }),
);

auth.get(
  '/me',
  authenticate,
  wrap(async (req, res) => {
    const u = await prisma.user.findUnique({ where: { id: req.user!.id } });
    if (!u) throw new HttpError(401, 'Unknown user', 'unauthenticated');
    res.json({ id: u.id, name: u.name, email: u.email, role: u.role, restaurantId: req.user!.restaurantId, emailVerified: !!u.emailVerifiedAt, mfaEnabled: u.mfaEnabled, recoveryCodesLeft: u.recoveryCodes.length });
  }),
);

// ---- staff management (owner only) ----
export const staff = Router();
staff.use(authenticate, requireRole('OWNER'));

staff.get(
  '/',
  wrap(async (req, res) => {
    rid(req);
    res.json(
      await prisma.user.findMany({
        where: { tenantId: req.user!.tenantId! },
        select: { id: true, name: true, email: true, role: true, active: true, restaurantId: true, mfaEnabled: true },
        orderBy: { createdAt: 'asc' },
      }),
    );
  }),
);

staff.post(
  '/',
  wrap(async (req, res) => {
    rid(req);
    const d = parse(
      z.object({
        name: z.string().trim().min(2),
        email: z.string().trim().toLowerCase().email(),
        password: passwordSchema,
        role: z.enum(['MANAGER', 'KITCHEN', 'WAITER']),
        restaurantId: z.string().optional(), // outlet to assign; defaults to the one you are working in
      }),
      req.body,
    );
    if (await prisma.user.findUnique({ where: { email: d.email } })) throw new HttpError(409, 'Email already in use', 'email_taken');
    await assertStaffRoom(req.user!.tenantId!);
    const outlet = d.restaurantId ?? rid(req);
    if (!(await prisma.restaurant.count({ where: { id: outlet, tenantId: req.user!.tenantId! } })))
      throw new HttpError(400, 'Unknown outlet', 'validation', { restaurantId: ['Unknown outlet'] });
    const u = await prisma.user.create({
      data: { tenantId: req.user!.tenantId!, restaurantId: outlet, email: d.email, name: d.name, role: d.role, passwordHash: await bcrypt.hash(d.password, 12) },
    });
    res.status(201).json({ id: u.id, name: u.name, email: u.email, role: u.role, active: u.active, restaurantId: u.restaurantId });
  }),
);

staff.patch(
  '/:id',
  wrap(async (req, res) => {
    const d = parse(z.object({ active: z.boolean().optional(), restaurantId: z.string().optional() }), req.body);
    if (d.active === true) await assertStaffRoom(req.user!.tenantId!);
    if (d.restaurantId && !(await prisma.restaurant.count({ where: { id: d.restaurantId, tenantId: req.user!.tenantId! } })))
      throw new HttpError(400, 'Unknown outlet', 'validation', { restaurantId: ['Unknown outlet'] });
    const r = await prisma.user.updateMany({
      where: { id: req.params.id, tenantId: req.user!.tenantId!, role: { not: 'OWNER' } },
      data: d,
    });
    if (!r.count) throw new HttpError(404, 'Not found', 'not_found');
    clearAuthCache(); // deactivation or a move must bite immediately, not when the old token expires
    if (d.active === false) await endAllSessions(req.params.id);
    res.json({ ok: true });
  }),
);

async function assertStaffRoom(tenantId: string) {
  const e = await getEntitlements(tenantId);
  if (!e.operational) throw new HttpError(402, 'Your subscription is not active. Renew it in Billing to continue.', 'subscription_inactive');
  assertWithin(e.limits.maxStaff, await prisma.user.count({ where: { tenantId, active: true, role: { not: 'OWNER' } } }), 'staff accounts');
}

export const MAX_FAILED_LOGINS = Number(process.env.MAX_FAILED_LOGINS ?? 8);
export const LOCK_MINUTES = Number(process.env.LOCK_MINUTES ?? 15);
const REUSE_LEEWAY_MS = Number(process.env.REFRESH_REUSE_LEEWAY_MS ?? 3000);
let dummy: Promise<string> | undefined;
const dummyHash = () => (dummy ??= bcrypt.hash('not-a-real-password', 12));

/** Changing the password signs out every other device. */
auth.post(
  '/change-password',
  limiter,
  authenticate,
  wrap(async (req, res) => {
    const d = parse(z.object({ current: z.string().min(1).max(200), next: passwordSchema }), req.body);
    const u = await prisma.user.findUnique({ where: { id: req.user!.id } });
    if (!u || !(await bcrypt.compare(d.current, u.passwordHash))) throw new HttpError(401, 'Your current password is not correct', 'bad_credentials');
    if (d.current === d.next) throw new HttpError(400, 'Choose a different password', 'validation', { next: ['Choose a different password'] });
    await prisma.$transaction([
      prisma.user.update({ where: { id: u.id }, data: { passwordHash: await bcrypt.hash(d.next, 12), failedLogins: 0, lockedUntil: null, tokensValidAfter: new Date() } }),
      prisma.refreshToken.updateMany({ where: { userId: u.id, revokedAt: null }, data: { revokedAt: new Date() } }),
    ]);
    clearAuthCache(u.id);
    res.json({ user: { id: u.id, name: u.name, email: u.email, role: u.role }, ...(await issue(u, res)) });
  }),
);
