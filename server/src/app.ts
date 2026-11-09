import express, { type Router, type ErrorRequestHandler } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import swaggerUi from 'swagger-ui-express';
import pinoHttp from 'pino-http';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';
import { config, isProd } from './config.js';
import { prisma } from './db.js';
import { ApiError, zodToApi } from './lib/http.js';
import { logger } from './lib/logger.js';
import { attachAuth } from './lib/auth.js';
import { authRouter } from './routes/auth.js';
import { restaurantRouter } from './routes/restaurant.js';
import { categoryRouter, menuRouter, productRouter, uploadRouter, UPLOAD_DIR } from './routes/menu.js';
import { publicRouter } from './routes/public.js';
import { orderRouter } from './routes/orders.js';
import { paymentRouter } from './routes/payments.js';
import { qrRouter, reservationRouter, tableRouter } from './routes/floor.js';
import { customerRouter } from './routes/customers.js';
import { inventoryRouter } from './routes/inventory.js';
import { staffRouter } from './routes/staff.js';
import { campaignRouter, marketingRouter } from './routes/marketing.js';
import { cmsRouter, deliveryRouter } from './routes/cms.js';
import { reportRouter } from './routes/reports.js';
import { aiRouter } from './routes/ai.js';
import { outletRouter } from './routes/outlets.js';
import { buildOpenApi } from './openapi.js';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(cors({ origin: config.WEB_ORIGIN.split(','), credentials: true }));
  app.use(pinoHttp({ logger, autoLogging: { ignore: (r) => r.url === '/api/health' } }));
  app.use(cookieParser());

  // webhooks need the raw body: skip JSON parsing there
  app.use((req, res, next) => (req.path === '/api/payments/webhook' ? next() : express.json({ limit: '2mb' })(req, res, next)));
  app.use('/api', rateLimit({ windowMs: 60_000, limit: process.env.NODE_ENV === 'test' ? 100_000 : 300, standardHeaders: true, legacyHeaders: false, message: { error: { code: 'RATE_LIMITED', message: 'Too many requests. Please slow down.' } } }));

  app.get('/api/health', async (_req, res) => {
    try { await prisma.$queryRaw`SELECT 1`; res.json({ ok: true }); } catch { res.status(503).json({ ok: false }); }
  });
  app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '30d', immutable: true, setHeaders: (r) => r.setHeader('X-Content-Type-Options', 'nosniff') }));

  const mounts: Array<[string, Router]> = [
    ['/api/auth', authRouter], ['/api/restaurant', restaurantRouter], ['/api/menus', menuRouter], ['/api/categories', categoryRouter],
    ['/api/products', productRouter], ['/api/uploads', uploadRouter], ['/api/public', publicRouter], ['/api/orders', orderRouter],
    ['/api/payments', paymentRouter], ['/api/tables', tableRouter], ['/api/qr', qrRouter], ['/api/reservations', reservationRouter],
    ['/api/customers', customerRouter], ['/api/inventory', inventoryRouter], ['/api/staff', staffRouter], ['/api/marketing', marketingRouter],
    ['/api/campaigns', campaignRouter], ['/api/cms', cmsRouter], ['/api/delivery', deliveryRouter], ['/api/reports', reportRouter], ['/api/ai', aiRouter], ['/api/outlets', outletRouter],
  ];
  for (const [p, r] of mounts) app.use(p, r);

  const spec = buildOpenApi(mounts);
  app.get('/api/openapi.json', (_req, res) => res.json(spec));
  app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(spec));

  // SEO: sitemap + robots served by the API (the web host proxies these paths)
  app.get('/sitemap.xml', async (_req, res) => {
    const base = config.PUBLIC_WEB_URL.replace(/\/$/, '');
    const [ps, cs] = await Promise.all([prisma.product.findMany({ where: { isPublished: true }, select: { slug: true, updatedAt: true } }), prisma.category.findMany({ where: { isActive: true }, select: { slug: true } })]);
    const fixed = ['', '/menu', '/about', '/reservations', '/events', '/gallery', '/offers', '/loyalty', '/contact', '/feedback', '/privacy', '/terms', '/refunds'];
    const urls = [...fixed.map((u) => `<url><loc>${base}${u}</loc></url>`), ...cs.map((c) => `<url><loc>${base}/menu?category=${c.slug}</loc></url>`), ...ps.map((p) => `<url><loc>${base}/menu/${p.slug}</loc><lastmod>${p.updatedAt.toISOString()}</lastmod></url>`)];
    res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.join('')}</urlset>`);
  });
  app.get('/robots.txt', (_req, res) => {
    const base = config.PUBLIC_WEB_URL.replace(/\/$/, '');
    res.type('text/plain').send(`User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /track/\nDisallow: /account\nSitemap: ${base}/sitemap.xml\n`);
  });

  app.use('/api', (_req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Unknown API endpoint' } }));

  const onError: ErrorRequestHandler = (err, req, res, _next) => {
    if (err instanceof ZodError) err = zodToApi(err);
    if (err instanceof ApiError) return void res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      if (err.code === 'P2002') return void res.status(409).json({ error: { code: 'CONFLICT', message: 'That value already exists' } });
      if (err.code === 'P2025') return void res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Record not found' } });
      if (err.code === 'P2003') return void res.status(400).json({ error: { code: 'BAD_REFERENCE', message: 'A referenced record does not exist' } });
    }
    if (err?.type === 'entity.parse.failed') return void res.status(400).json({ error: { code: 'BAD_JSON', message: 'Malformed JSON body' } });
    if (err?.code === 'LIMIT_FILE_SIZE') return void res.status(413).json({ error: { code: 'TOO_LARGE', message: 'File is too large (max 5 MB)' } });
    (req as any).log?.error({ err }, 'unhandled error');
    res.status(500).json({ error: { code: 'INTERNAL', message: isProd ? 'Something went wrong' : String(err?.message ?? err) } });
  };
  app.use(onError);
  void attachAuth;
  return app;
}
