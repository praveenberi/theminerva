import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { z } from 'zod';

export const env = {
  jwtSecret: process.env.JWT_SECRET ?? '',
  port: Number(process.env.PORT ?? 4000),
  webOrigin: process.env.WEB_ORIGIN ?? 'http://localhost:5173',
  isProd: process.env.NODE_ENV === 'production',
};
if (env.jwtSecret.length < 32) throw new Error('JWT_SECRET must be set (>= 32 chars)');

export const prisma = new PrismaClient();

export class HttpError extends Error {
  constructor(public status: number, message: string, public code = 'error', public details?: unknown) {
    super(message);
  }
}

export interface AuthUser {
  id: string;
  role: 'SUPER_ADMIN' | 'OWNER' | 'MANAGER' | 'KITCHEN' | 'WAITER';
  tenantId: string | null;
  restaurantId: string | null;
  iatMs?: number; // issue time in milliseconds (JWT's own iat only has one-second resolution)
}

// Pin the algorithm (never trust the token's own header) and bind tokens to this service.
const JWT_BINDING = { issuer: 'tablely-api', audience: 'tablely-web' };
export const signAccess = (u: AuthUser) => jwt.sign({ id: u.id, role: u.role, tenantId: u.tenantId, restaurantId: u.restaurantId, iatMs: Date.now() }, env.jwtSecret, { ...JWT_BINDING, algorithm: 'HS256', expiresIn: '15m' });
export const verifyAccess = (t: string) => jwt.verify(t, env.jwtSecret, { ...JWT_BINDING, algorithms: ['HS256'] }) as AuthUser;
export const newRefreshToken = () => crypto.randomBytes(48).toString('base64url');
export const hashToken = (t: string) => crypto.createHash('sha256').update(t).digest('hex');

export function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw new HttpError(400, 'Validation failed', 'validation', r.error.flatten().fieldErrors);
  }
  return r.data;
}

export const slugify = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'restaurant';

const COMMON_PASSWORDS = new Set(['password', 'password1', 'password12', 'password123', 'password1234', '1234567890', '123456789', '12345678', 'qwertyuiop', 'qwerty123', 'iloveyou1', 'admin12345', 'letmein123', 'welcome123', 'abc123456', 'changeme123', 'passw0rd123', 'password1!']);
/** bcrypt only reads the first 72 bytes, so longer passwords are rejected instead of silently truncated. */
export const passwordSchema = z
  .string()
  .min(10, 'Use at least 10 characters')
  .refine((p) => Buffer.byteLength(p) <= 72, 'Use at most 72 characters')
  .refine((p) => !COMMON_PASSWORDS.has(p.toLowerCase()), 'That password is too common')
  .refine((p) => !/^(.)\1+$/.test(p), 'That password is too repetitive');

/** Settings that are fine on a laptop but dangerous on a public server. Pure, so it can be tested. */
export function productionConfigProblems(e: NodeJS.ProcessEnv): string[] {
  const p: string[] = [];
  const jwtSecret = e.JWT_SECRET ?? '';
  if (jwtSecret.length < 48 || /change-?me|dev-only|example|secret123/i.test(jwtSecret)) p.push('JWT_SECRET must be a random value of at least 48 characters (not a placeholder)');
  if ((e.SECRETS_KEY ?? '').length < 32) p.push('SECRETS_KEY must be set to 32+ random characters');
  if (!(e.WEB_ORIGIN ?? '').startsWith('https://')) p.push('WEB_ORIGIN must be the https URL of the web app');
  if (!(e.PUBLIC_API_URL ?? '').startsWith('https://')) p.push('PUBLIC_API_URL must be the public https URL of this API');
  if ((e.DATABASE_URL ?? '').includes('tablely:tablely@')) p.push('DATABASE_URL still uses the development database credentials');
  if (!(e.RESEND_API_KEY && e.EMAIL_FROM)) p.push('An email provider (RESEND_API_KEY and EMAIL_FROM) must be configured: password reset and email confirmation cannot work without it');
  if (e.ENABLE_TEST_PAYMENTS === '1' || e.ENABLE_TEST_MESSAGING === '1') p.push('ENABLE_TEST_PAYMENTS / ENABLE_TEST_MESSAGING must be off (they are ignored in production, but should not be set)');
  return p;
}
export function assertProductionConfig() {
  if (!env.isProd) return;
  const problems = productionConfigProblems(process.env);
  if (problems.length) throw new Error(`Refusing to start in production:\n - ${problems.join('\n - ')}`);
}

/** Issued after a correct password when MFA is on. Different audience from access tokens, so it cannot be used as one. */
export const signMfaToken = (userId: string) => jwt.sign({ uid: userId, purpose: 'mfa' }, env.jwtSecret, { issuer: 'tablely-api', audience: 'tablely-mfa', algorithm: 'HS256', expiresIn: '5m' });
export function verifyMfaToken(t: string): string {
  const c = jwt.verify(t, env.jwtSecret, { issuer: 'tablely-api', audience: 'tablely-mfa', algorithms: ['HS256'] }) as { uid: string; purpose: string };
  if (c.purpose !== 'mfa') throw new Error('wrong token');
  return c.uid;
}
