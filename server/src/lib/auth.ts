import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import type { NextFunction, Request, Response } from 'express';
import type { Role } from '@prisma/client';
import { config, isProd } from '../config.js';
import { prisma } from '../db.js';
import { forbidden, unauthorized } from './http.js';
import { can, type Permission } from './permissions.js';

export interface AuthUser { kind: 'staff'; id: string; role: Role; name: string; email: string }
export interface AuthCustomer { kind: 'customer'; id: string; name: string }
declare module 'express-serve-static-core' {
  interface Request { staff?: AuthUser; customer?: AuthCustomer }
}

export const hashPassword = (p: string) => bcrypt.hash(p, 12);
export const verifyPassword = (p: string, h: string) => bcrypt.compare(p, h);
export const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
export const randomToken = () => crypto.randomBytes(48).toString('base64url');

export const signAccess = (p: AuthUser | AuthCustomer) =>
  jwt.sign(p, config.JWT_ACCESS_SECRET, { expiresIn: '15m' });

const REFRESH_DAYS = 30;
export const REFRESH_COOKIE = 'minerva_rt';

export async function issueRefresh(res: Response, owner: { staffId?: string; customerId?: string }) {
  const token = randomToken();
  const expiresAt = new Date(Date.now() + REFRESH_DAYS * 864e5);
  if (owner.staffId)
    await prisma.refreshToken.create({ data: { userId: owner.staffId, tokenHash: sha256(token), expiresAt } });
  else
    await prisma.customerRefreshToken.create({ data: { customerId: owner.customerId!, tokenHash: sha256(token), expiresAt } });
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true, secure: isProd, sameSite: 'strict', path: '/api/auth', maxAge: REFRESH_DAYS * 864e5,
  });
}
export const clearRefresh = (res: Response) => res.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });

function bearer(req: Request) {
  const h = req.headers.authorization;
  return h?.startsWith('Bearer ') ? h.slice(7) : undefined;
}

/** Populates req.staff / req.customer if a valid access token is present (never throws). */
export async function attachAuth(req: Request, _res: Response, next: NextFunction) {
  const t = bearer(req);
  if (t) {
    try {
      const p = jwt.verify(t, config.JWT_ACCESS_SECRET) as AuthUser | AuthCustomer;
      if (p.kind === 'staff') {
        // re-check the account is still active and role unchanged (permissions enforced from DB truth)
        const u = await prisma.user.findUnique({ where: { id: p.id } });
        if (u?.isActive) req.staff = { kind: 'staff', id: u.id, role: u.role, name: u.name, email: u.email };
      } else if (p.kind === 'customer') req.customer = p;
    } catch { /* invalid token → anonymous */ }
  }
  next();
}

export const requireStaff = (req: Request, _res: Response, next: NextFunction) =>
  req.staff ? next() : next(unauthorized());

export const requireCustomer = (req: Request, _res: Response, next: NextFunction) =>
  req.customer ? next() : next(unauthorized());

export const requirePerm = (...perms: Permission[]) => (req: Request, _res: Response, next: NextFunction) => {
  if (!req.staff) return next(unauthorized());
  if (!perms.some((p) => can(req.staff!.role, p))) return next(forbidden());
  next();
};
