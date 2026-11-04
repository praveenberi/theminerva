import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { HttpError, parse, prisma, slugify } from '../lib/core';
import { authenticate, requireRole, rid, wrap } from '../middleware/auth';
import { range } from './ops';
import { assertFeature } from '../lib/billing';

/**
 * An outlet is a Restaurant row inside the tenant. Everything else (menu, prices, tables, orders, inventory,
 * coupons, delivery zones, staff) is already scoped by restaurantId, so outlets are isolated from each other
 * by the same mechanism that isolates tenants. These routes only deal with the tenant-level view.
 */
export const outlets = Router();
const owner = [authenticate, requireRole('OWNER')] as const;

const tenantOutlets = (tenantId: string) => prisma.restaurant.findMany({ where: { tenantId }, orderBy: { createdAt: 'asc' } });

outlets.get('/outlets', authenticate, wrap(async (req, res) => {
  const { tenantId, restaurantId, role } = req.user!;
  if (!tenantId) throw new HttpError(403, 'No tenant', 'forbidden');
  const [all, tenant] = await Promise.all([tenantOutlets(tenantId), prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } })]);
  const visible = role === 'OWNER' ? all : all.filter((o) => o.id === restaurantId); // staff only ever see their own outlet
  res.json({
    maxOutlets: tenant.maxOutlets, canAdd: role === 'OWNER' && all.length < tenant.maxOutlets,
    outlets: visible.map((o) => ({ id: o.id, name: o.name, slug: o.slug, address: o.address, published: o.published, current: o.id === restaurantId })),
  });
}));

outlets.post('/outlets', ...owner, wrap(async (req, res) => {
  const d = parse(z.object({ name: z.string().trim().min(2).max(80), address: z.string().max(200).optional(), copyMenuFrom: z.string().optional() }), req.body);
  const tenantId = req.user!.tenantId!;
  const current = await prisma.restaurant.findUniqueOrThrow({ where: { id: rid(req) } });
  if ((await prisma.restaurant.count({ where: { tenantId } })) >= 1) await assertFeature(tenantId, 'multi_outlet');
  if (d.copyMenuFrom && !(await prisma.restaurant.count({ where: { id: d.copyMenuFrom, tenantId } })))
    throw new HttpError(400, 'Unknown outlet to copy from', 'validation', { copyMenuFrom: ['Unknown outlet'] });

  const created = await prisma.$transaction(async (tx) => {
    // lock the tenant row so two simultaneous requests cannot both slip under the limit
    await tx.$queryRaw`SELECT id FROM "Tenant" WHERE id = ${tenantId} FOR UPDATE`;
    const [tenant, count] = await Promise.all([tx.tenant.findUniqueOrThrow({ where: { id: tenantId } }), tx.restaurant.count({ where: { tenantId } })]);
    if (count >= tenant.maxOutlets)
      throw new HttpError(403, `Your plan allows ${tenant.maxOutlets} outlet${tenant.maxOutlets === 1 ? '' : 's'}. Contact support to add more.`, 'outlet_limit');

    const base = slugify(d.name);
    let slug = base;
    for (let i = 2; await tx.restaurant.findUnique({ where: { slug } }); i++) slug = `${base}-${i}`;
    const outlet = await tx.restaurant.create({
      data: {
        tenantId, slug, name: d.name, address: d.address ?? '', published: false,
        category: current.category, currency: current.currency, taxPercent: current.taxPercent, serviceChargePercent: current.serviceChargePercent,
        orderTypes: current.orderTypes, openTime: current.openTime, closeTime: current.closeTime, reservationSlotMinutes: current.reservationSlotMinutes,
      },
    });
    if (d.copyMenuFrom) {
      // an independent copy: from here on each outlet edits its own prices and availability
      const cats = await tx.category.findMany({ where: { restaurantId: d.copyMenuFrom }, include: { products: true }, orderBy: { sort: 'asc' } });
      for (const c of cats) {
        const nc = await tx.category.create({ data: { restaurantId: outlet.id, name: c.name, sort: c.sort } });
        if (c.products.length)
          await tx.product.createMany({
            data: c.products.map((p) => ({
              restaurantId: outlet.id, categoryId: nc.id, name: p.name, description: p.description, priceCents: p.priceCents,
              discountPriceCents: p.discountPriceCents, imageUrl: p.imageUrl, available: p.available, dietary: p.dietary, allergens: p.allergens,
              prepMinutes: p.prepMinutes, sort: p.sort, variants: p.variants as Prisma.InputJsonValue, addons: p.addons as Prisma.InputJsonValue,
            })),
          });
      }
    }
    await tx.auditLog.create({ data: { restaurantId: outlet.id, actorId: req.user!.id, action: 'outlet.create', detail: { copyMenuFrom: d.copyMenuFrom ?? null } } });
    return outlet;
  });
  res.status(201).json({ id: created.id, name: created.name, slug: created.slug });
}));

/** Side-by-side performance of every outlet for a date range. */
outlets.get('/outlets/compare', ...owner, wrap(async (req, res) => {
  const q = parse(z.object({
    range: z.enum(['today', 'yesterday', '7d', '30d', 'custom']).default('7d'),
    from: z.string().optional(), to: z.string().optional(), tzOffset: z.coerce.number().int().min(-840).max(840).default(0),
  }), req.query);
  const { from, to } = range(q);
  const all = await tenantOutlets(req.user!.tenantId!);
  const ids = all.map((o) => o.id);
  const window = { restaurantId: { in: ids }, createdAt: { gte: from, lt: to } };
  const [sales, cancelled, reservations] = await Promise.all([
    prisma.order.groupBy({ by: ['restaurantId'], where: { ...window, status: { notIn: ['CANCELLED', 'PENDING_PAYMENT'] } }, _sum: { totalCents: true }, _count: { _all: true } }),
    prisma.order.groupBy({ by: ['restaurantId'], where: { ...window, status: 'CANCELLED' }, _count: { _all: true } }),
    prisma.reservation.groupBy({ by: ['restaurantId'], where: { restaurantId: { in: ids }, startsAt: { gte: from, lt: to }, status: { not: 'CANCELLED' } }, _count: { _all: true } }),
  ]);
  const rows = all.map((o) => {
    const s = sales.find((x) => x.restaurantId === o.id);
    const n = s?._count._all ?? 0, rev = s?._sum.totalCents ?? 0;
    return {
      id: o.id, name: o.name, currency: o.currency, orders: n, revenueCents: rev, averageOrderCents: n ? Math.round(rev / n) : 0,
      cancelledOrders: cancelled.find((x) => x.restaurantId === o.id)?._count._all ?? 0, reservations: reservations.find((x) => x.restaurantId === o.id)?._count._all ?? 0,
    };
  });
  // revenue is only summed when every outlet shares a currency; otherwise a total would be meaningless
  const single = new Set(rows.map((r) => r.currency)).size === 1;
  res.json({ range: { from, to }, outlets: rows, totalRevenueCents: single ? rows.reduce((s, r) => s + r.revenueCents, 0) : null, totalOrders: rows.reduce((s, r) => s + r.orders, 0) });
}));

/** One profile per phone number across all outlets of the tenant. Loyalty points stay per outlet (shown as a total). */
outlets.get('/outlets/customers', ...owner, wrap(async (req, res) => {
  const ids = (await tenantOutlets(req.user!.tenantId!)).map((o) => o.id);
  const rows = await prisma.$queryRaw<{ phone: string; name: string; outlets: number; orders: number; spent: number; points: number }[]>`
    SELECT c.phone, MAX(c.name) AS name, COUNT(DISTINCT c."restaurantId")::int AS outlets,
           COALESCE(SUM(s.orders), 0)::int AS orders, COALESCE(SUM(s.spent), 0)::int AS spent, SUM(c."loyaltyPoints")::int AS points
    FROM "Customer" c
    LEFT JOIN (SELECT "customerId", COUNT(*) AS orders, SUM("totalCents") AS spent FROM "Order"
               WHERE status NOT IN ('CANCELLED', 'PENDING_PAYMENT') GROUP BY "customerId") s ON s."customerId" = c.id
    WHERE c."restaurantId" IN (${Prisma.join(ids)})
    GROUP BY c.phone ORDER BY spent DESC, name LIMIT 500`;
  res.json(rows);
}));
