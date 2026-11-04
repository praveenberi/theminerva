import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { AuthUser, HttpError, env, prisma, verifyAccess } from '../lib/core';

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
      emailVerified?: boolean;
      mfaEnabled?: boolean;
    }
  }
}

/**
 * A signed token only proves who someone was when it was issued. These facts can change in the 15 minutes a token
 * lives (staff deactivated or moved, role changed, business suspended), so they are re-checked against the database,
 * cached for a few seconds to keep the cost down. Code that changes them calls clearAuthCache() so the change bites at once
 * on this server; with several servers it takes at most AUTH_CACHE_MS to reach the others.
 */
const AUTH_CACHE_MS = Number(process.env.AUTH_CACHE_MS ?? 10_000);
const cache = new Map<string, { at: number; v: Standing | null }>();
interface Standing { active: boolean; role: string; restaurantId: string | null; tenantStatus: string | null; emailVerified: boolean; mfaEnabled: boolean; validAfter: number | null }

export const clearAuthCache = (userId?: string) => (userId ? cache.delete(userId) : cache.clear());

async function standing(userId: string): Promise<Standing | null> {
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.at < AUTH_CACHE_MS) return hit.v;
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { active: true, role: true, restaurantId: true, emailVerifiedAt: true, mfaEnabled: true, tokensValidAfter: true, tenant: { select: { status: true } } } });
  const v = u && { active: u.active, role: u.role, restaurantId: u.restaurantId, tenantStatus: u.tenant?.status ?? null, emailVerified: !!u.emailVerifiedAt, mfaEnabled: u.mfaEnabled, validAfter: u.tokensValidAfter ? u.tokensValidAfter.getTime() : null };
  if (cache.size > 5000) cache.clear(); // bounded memory
  cache.set(userId, { at: Date.now(), v });
  return v;
}

export const authenticate: RequestHandler = async (req, _res, next) => {
  try {
    const h = req.headers.authorization;
    if (!h?.startsWith('Bearer ')) throw new HttpError(401, 'Authentication required', 'unauthenticated');
    let claims: AuthUser;
    try {
      claims = verifyAccess(h.slice(7));
    } catch {
      throw new HttpError(401, 'Invalid or expired token', 'unauthenticated');
    }
    const s = await standing(claims.id);
    if (!s || !s.active) throw new HttpError(401, 'Invalid or expired token', 'unauthenticated');
    if (s.tenantStatus === 'SUSPENDED') throw new HttpError(403, 'This account is suspended', 'suspended');
    // Security events (password change/reset, MFA changes, deactivation) set a cutoff: access tokens issued before it are dead at once.
    if (s.validAfter != null && (claims.iatMs ?? 0) < s.validAfter) throw new HttpError(401, 'Invalid or expired token', 'unauthenticated');
    // a changed role, or staff moved to another outlet, invalidates the old token: the client refreshes and gets a correct one
    if (s.role !== claims.role) throw new HttpError(401, 'Invalid or expired token', 'unauthenticated');
    if (s.restaurantId && claims.restaurantId !== s.restaurantId) throw new HttpError(401, 'Invalid or expired token', 'unauthenticated');
    // The platform admin can do the most damage, so in production it must have MFA before it may do anything but set it up.
    if (claims.role === 'SUPER_ADMIN' && !s.mfaEnabled && adminMfaRequired() && !req.originalUrl.startsWith('/api/auth/'))
      throw new HttpError(403, 'Set up two-factor authentication to continue.', 'mfa_setup_required');
    req.user = claims;
    req.emailVerified = s.emailVerified;
    req.mfaEnabled = s.mfaEnabled;
    next();
  } catch (e) {
    next(e);
  }
};

const adminMfaRequired = () => process.env.MFA_REQUIRE_ADMIN === '1' || (env.isProd && process.env.MFA_REQUIRE_ADMIN !== '0');

/** Actions that reach other people or move money need an owner whose email address has been confirmed. */
export const requireVerifiedEmail: RequestHandler = (req, _res, next) => {
  if (process.env.REQUIRE_VERIFIED_EMAIL === '0' || req.user?.role === 'SUPER_ADMIN' || req.emailVerified) return next();
  next(new HttpError(403, 'Confirm your email address first. Check your inbox, or resend the link from Account.', 'email_unverified'));
};

export const requireRole =
  (...roles: AuthUser['role'][]): RequestHandler =>
  (req, _res, next) => {
    if (!req.user || !roles.includes(req.user.role)) return next(new HttpError(403, 'Forbidden', 'forbidden'));
    next();
  };

/** Every tenant-scoped route reads its restaurant id from the verified token, never from the request. */
export function rid(req: Request): string {
  const id = req.user?.restaurantId;
  if (!id) throw new HttpError(403, 'No restaurant on this account', 'forbidden');
  return id;
}

/**
 * CSRF guard for the endpoints that act on the refresh cookie. Browsers always send Origin on cross-site POSTs, so a
 * request from any origin other than our web app is refused. Requests without an Origin (curl, server-to-server) can't be
 * driven by a victim's browser and are allowed.
 */
export const sameOriginOnly: RequestHandler = (req, _res, next) => {
  const o = req.headers.origin;
  if (o && o !== env.webOrigin) return next(new HttpError(403, 'Cross-site request refused', 'bad_origin'));
  next();
};

export const wrap =
  (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler =>
  (req, res, next: NextFunction) => {
    fn(req, res).catch(next);
  };

export const MANAGE = ['OWNER', 'MANAGER'] as const;
export const STAFF = ['OWNER', 'MANAGER', 'KITCHEN', 'WAITER'] as const;

/** Ends every session of a user right now: refresh tokens are revoked and access tokens issued before this moment stop working. */
export async function endAllSessions(userId: string) {
  await prisma.$transaction([
    prisma.user.update({ where: { id: userId }, data: { tokensValidAfter: new Date() } }),
    prisma.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } }),
  ]);
  clearAuthCache(userId);
}
