import express, { type ErrorRequestHandler } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import crypto from 'node:crypto';
import { HttpError, env, prisma } from './lib/core';
import { auth, staff } from './routes/auth';
import { adminMfa, auth2, staffMfa } from './routes/auth2';
import { manage } from './routes/manage';
import { admin, ops } from './routes/ops';
import { reports } from './routes/reports';
import { pub } from './routes/public';
import { inventory } from './routes/inventory';
import { kitchen } from './routes/kitchen';
import { outlets } from './routes/outlets';
import { marketing } from './routes/marketing';
import { billing, billingAdmin, publicPlans } from './routes/billing';
import { paymentAccount } from './routes/paymentAccount';
import { payments, testPay } from './routes/payments';
import { billingTick, birthdays } from './lib/jobs';

/** Tracking codes, unsubscribe links and webhook tokens are bearer secrets that live in URL paths; never write them to logs. */
export function redactPath(url: string): string {
  return url.split('?')[0]
    .replace(/(\/orders\/track\/)[^/]+/, '$1:code')
    .replace(/(\/unsubscribe\/)[^/]+/, '$1:token')
    .replace(/(\/payments\/webhook\/[^/]+\/)[^/]+/, '$1:token');
}

/** PostgreSQL cannot store a NUL character, so one anywhere in a request would surface as a server error. Refuse it up front. */
function hasNul(v: unknown, depth = 0): boolean {
  if (typeof v === 'string') return v.includes('\u0000');
  if (depth > 12 || v === null || typeof v !== 'object' || Buffer.isBuffer(v)) return false; // webhook bodies are raw bytes, not text fields
  return Object.entries(v as Record<string, unknown>).some(([k, x]) => k.includes('\u0000') || hasNul(x, depth + 1));
}

export function createApp() {
  const app = express();
  // Only trust X-Forwarded-For when a known number of proxies sits in front (TRUST_PROXY=1 behind one load balancer).
  // Trusting it blindly lets any client pick its own IP and walk around the rate limits.
  app.set('trust proxy', Number(process.env.TRUST_PROXY ?? 0));
  app.use(helmet());
  app.use(cors({ origin: env.webOrigin, credentials: true }));
  // webhooks need the untouched bytes for signature verification, so they bypass the JSON parser
  app.use('/api/payments/webhook', express.raw({ type: '*/*', limit: '256kb' }));
  // menu photos arrive as the raw file bytes (the web app shrinks them first, so 1 MB is generous)
  app.use('/api/images', express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: '1mb' }));
  app.use('/api/menu/import', express.json({ limit: '700kb' })); // the only endpoint that legitimately takes a big body
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());
  app.use((req, res, next) => {
    // reuse the id a trusted proxy assigned, else make one; it is returned to the client and written to the log
    const id = (typeof req.headers['x-request-id'] === 'string' && /^[\w-]{8,64}$/.test(req.headers['x-request-id']) ? req.headers['x-request-id'] : crypto.randomUUID());
    res.locals.requestId = id;
    res.set('X-Request-Id', id);
    next();
  });
  if (process.env.NODE_ENV !== 'test') {
    app.use((req, res, next) => {
      const t = Date.now();
      res.on('finish', () => console.log(JSON.stringify({ id: res.locals.requestId, m: req.method, u: redactPath(req.originalUrl), s: res.statusCode, ms: Date.now() - t })));
      next();
    });
  }
  app.use('/api', (req, _res, next) => {
    if (/%00/i.test(req.originalUrl) || hasNul(req.query) || hasNul(req.body)) return next(new HttpError(400, 'Request contains invalid characters', 'validation'));
    next();
  });
  // API responses carry tokens and personal data: never let a browser or proxy cache them.
  app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  // Coarse per-IP ceiling for everything; sensitive endpoints (login, orders, bookings) have tighter limits of their own.
  // Providers' webhooks and health checks are exempt.
  app.use('/api', rateLimit({
    windowMs: 60_000, limit: Number(process.env.API_RATE_LIMIT ?? 600), standardHeaders: true, legacyHeaders: false,
    skip: (req) => req.originalUrl.startsWith('/api/payments/webhook') || req.originalUrl === '/api/health' || req.originalUrl === '/api/ready',
  }));

  // liveness: the process is up (restart it if this fails)
  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  // readiness: the process can serve traffic, i.e. the database answers (stop sending requests while this fails)
  app.get('/api/ready', async (_req, res) => {
    try { await prisma.$queryRaw`SELECT 1`; res.json({ ok: true }); } catch { res.status(503).json({ ok: false }); }
  });
  // Scheduled jobs for hosts without a long-running process (Vercel Cron calls this with "Authorization: Bearer $CRON_SECRET").
  // Disabled unless CRON_SECRET is set (24+ characters); compared in constant time.
  app.get('/api/cron/run', async (req, res, next) => {
    try {
      const secret = process.env.CRON_SECRET ?? '';
      const given = Buffer.from(String(req.headers.authorization ?? '').replace(/^Bearer /, ''));
      const want = Buffer.from(secret);
      if (secret.length < 24 || given.length !== want.length || !crypto.timingSafeEqual(given, want)) throw new HttpError(401, 'Not allowed', 'unauthorized');
      const [vouchers, billing] = await Promise.all([birthdays(), billingTick()]);
      res.json({ ok: true, birthdays: vouchers, billing });
    } catch (e) { next(e); }
  });
  app.use('/api/auth', auth);
  app.use('/api/auth', auth2);
  app.use('/api/staff', staff);
  app.use('/api/staff', staffMfa);
  app.use('/api/public/payments/test', testPay);
  app.use('/api/public/plans', publicPlans);
  app.use('/api/public', pub);
  app.use('/api/payments', payments);
  app.use('/api/admin', admin);
  app.use('/api/admin', billingAdmin);
  app.use('/api/admin', adminMfa);
  app.use('/api', billing);
  app.use('/api', paymentAccount);
  app.use('/api', manage);
  app.use('/api', inventory);
  app.use('/api', kitchen);
  app.use('/api', outlets);
  app.use('/api', marketing);
  app.use('/api', reports);
  app.use('/api', ops);
  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not found', 'not_found')));

  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    if (err instanceof HttpError) return void res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    if (err?.type === 'entity.parse.failed') return void res.status(400).json({ error: { code: 'bad_json', message: 'Invalid JSON' } });
    if (err?.type === 'entity.too.large') return void res.status(413).json({ error: { code: 'too_large', message: 'Request is too large' } });
    if (err?.code === 'P2010' || /22021|invalid byte sequence/.test(String(err?.message))) return void res.status(400).json({ error: { code: 'validation', message: 'Request contains invalid characters' } });
    console.error(JSON.stringify({ event: 'unhandled_error', id: res.locals.requestId, error: String(err?.stack ?? err).slice(0, 2000) }));
    res.status(500).json({ error: { code: 'internal', message: 'Something went wrong' } });
  };
  app.use(onError);
  return app;
}
