import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { HttpError, parse, prisma } from '../lib/core';
import { assertFeature, getEntitlements } from '../lib/billing';
import { EXPORT_TYPES, ExportFormat, exportFilename, exportReport } from '../lib/exporters';
import { REPORTS, buildReport, findReport } from '../lib/reports';
import { MANAGE, authenticate, requireRole, rid, wrap } from '../middleware/auth';

export const reports = Router();
reports.use('/reports', authenticate, requireRole(...MANAGE)); // scoped: this router is mounted ahead of routes used by kitchen and waiter roles

const exportLimit = rateLimit({
  windowMs: 60_000, limit: Number(process.env.EXPORT_RATE_LIMIT ?? 20), standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => req.user?.id ?? req.ip ?? 'anon', message: { error: 'rate_limited', message: 'Too many exports. Try again in a minute.' },
});

const periodQuery = z.object({
  preset: z.enum(['today', 'yesterday', '7d', '30d', 'mtd', 'lastMonth']).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

/** The report must exist, the role must be allowed to see it, and the plan must include it. */
async function access(req: Express.Request & { user?: any }, key: string) {
  const def = findReport(key);
  if (!def) throw new HttpError(404, 'Unknown report', 'not_found');
  if (def.ownerOnly && req.user.role !== 'OWNER' && req.user.role !== 'SUPER_ADMIN') throw new HttpError(403, 'Only the owner can see this report', 'forbidden');
  if (def.tier === 'advanced' && req.user.role !== 'SUPER_ADMIN') await assertFeature(req.user.tenantId, 'advanced_reports');
  return def;
}

reports.get('/reports', wrap(async (req, res) => {
  const e = req.user!.tenantId ? await getEntitlements(req.user!.tenantId) : null;
  const owner = req.user!.role === 'OWNER' || req.user!.role === 'SUPER_ADMIN';
  const r = await prisma.restaurant.findUniqueOrThrow({ where: { id: rid(req) }, select: { currency: true, utcOffsetMinutes: true } });
  res.json({
    currency: r.currency, utcOffsetMinutes: r.utcOffsetMinutes,
    reports: REPORTS.filter((d) => !d.ownerOnly || owner).map((d) => ({
      key: d.key, title: d.title, description: d.description, group: d.group, tier: d.tier,
      available: d.tier === 'basic' || req.user!.role === 'SUPER_ADMIN' || !!(e && e.operational && e.features.has('advanced_reports')),
    })),
  });
}));

reports.get('/reports/:key', wrap(async (req, res) => {
  const def = await access(req, req.params.key);
  const spec = parse(periodQuery, req.query);
  res.json(await buildReport(def, rid(req), spec));
}));

reports.get('/reports/:key/export', exportLimit, wrap(async (req, res) => {
  const def = await access(req, req.params.key);
  const { format, ...spec } = parse(periodQuery.extend({ format: z.enum(['csv', 'xlsx', 'pdf']) }), req.query);
  const built = await buildReport(def, rid(req), spec);
  const body = await exportReport(built, format as ExportFormat);
  await prisma.auditLog.create({ data: { restaurantId: rid(req), actorId: req.user!.id, action: 'report.export', detail: { report: def.key, format, from: built.period.from, to: built.period.to, rows: built.rows.length } } });
  res.setHeader('Content-Type', EXPORT_TYPES[format as ExportFormat]);
  res.setHeader('Content-Disposition', `attachment; filename="${exportFilename(built, format as ExportFormat)}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.send(body);
}));
