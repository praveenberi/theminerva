import { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { badRequest } from '../lib/http.js';
import { addDays, localDate, zonedToUtc } from '../lib/time.js';

export type RangeKey = 'today' | 'yesterday' | 'last7' | 'last30' | 'this_month' | 'prev_month' | 'custom';

export async function tzOf() {
  return (await prisma.restaurant.findUnique({ where: { id: 'minerva' } }))?.timezone ?? 'Asia/Singapore';
}

/** [from, to) in UTC derived from restaurant-local calendar days */
export async function resolveRange(key: RangeKey, fromStr?: string, toStr?: string) {
  const tz = await tzOf();
  const today = localDate(new Date(), tz);
  let a: string, b: string; // local dates, b exclusive
  switch (key) {
    case 'today': a = today; b = addDays(today, 1); break;
    case 'yesterday': a = addDays(today, -1); b = today; break;
    case 'last7': a = addDays(today, -6); b = addDays(today, 1); break;
    case 'last30': a = addDays(today, -29); b = addDays(today, 1); break;
    case 'this_month': a = today.slice(0, 8) + '01'; b = addDays(today, 1); break;
    case 'prev_month': {
      const first = today.slice(0, 8) + '01';
      b = first;
      const d = new Date(first + 'T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() - 1);
      a = d.toISOString().slice(0, 10);
      break;
    }
    case 'custom':
      if (!fromStr || !toStr || !/^\d{4}-\d{2}-\d{2}$/.test(fromStr) || !/^\d{4}-\d{2}-\d{2}$/.test(toStr)) throw badRequest('Custom range needs from and to as YYYY-MM-DD');
      if (toStr < fromStr) throw badRequest('End date is before start date');
      a = fromStr; b = addDays(toStr, 1); break;
    default: throw badRequest('Unknown range');
  }
  return { tz, from: zonedToUtc(a, '00:00', tz), to: zonedToUtc(b, '00:00', tz), fromLocal: a, toLocal: addDays(b, -1) };
}

const REAL = Prisma.sql`o.status NOT IN ('CANCELLED','REJECTED')`;
const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));

export async function dashboard(from: Date, to: Date, tz: string, outletId?: string | null) {
  const OF = outletId ? Prisma.sql`AND o."outletId" = ${outletId}` : Prisma.empty;
  const ow = outletId ? { outletId } : {};
  const L = Prisma.sql`(o."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE ${tz})`;
  const [byStatus, completed, activeCust, best, cats, trend, pay, staff, lowStock, resv, recent, refunds] = await Promise.all([
    prisma.order.groupBy({ by: ['status'], where: { createdAt: { gte: from, lt: to }, ...ow }, _count: true }),
    prisma.order.aggregate({ where: { status: 'COMPLETED', createdAt: { gte: from, lt: to }, ...ow }, _sum: { total: true, discount: true }, _avg: { total: true }, _count: true }),
    prisma.order.findMany({ where: { createdAt: { gte: from, lt: to }, status: { notIn: ['CANCELLED', 'REJECTED'] }, customerId: { not: null }, ...ow }, distinct: ['customerId'], select: { customerId: true } }),
    prisma.$queryRaw<any[]>`SELECT i.name, SUM(i.quantity)::int qty, SUM(i."lineTotal") revenue FROM "OrderItem" i JOIN "Order" o ON o.id=i."orderId" WHERE o.status='COMPLETED' AND o."createdAt">=${from} AND o."createdAt"<${to} ${OF} GROUP BY i.name ORDER BY qty DESC LIMIT 8`,
    prisma.$queryRaw<any[]>`SELECT c.name, SUM(i.quantity)::int qty, SUM(i."lineTotal") revenue FROM "OrderItem" i JOIN "Order" o ON o.id=i."orderId" JOIN "Product" p ON p.id=i."productId" JOIN "Category" c ON c.id=p."categoryId" WHERE o.status='COMPLETED' AND o."createdAt">=${from} AND o."createdAt"<${to} ${OF} GROUP BY c.name ORDER BY revenue DESC LIMIT 6`,
    prisma.$queryRaw<any[]>`SELECT to_char(${L}, 'YYYY-MM-DD') AS day, COUNT(*)::int orders, COALESCE(SUM(CASE WHEN o.status='COMPLETED' THEN o.total END),0) revenue FROM "Order" o WHERE ${REAL} AND o."createdAt">=${from} AND o."createdAt"<${to} ${OF} GROUP BY 1 ORDER BY 1`,
    prisma.$queryRaw<any[]>`SELECT p.method, p.status, COUNT(*)::int n, SUM(p.amount) amount FROM "Payment" p WHERE p."createdAt">=${from} AND p."createdAt"<${to} GROUP BY 1,2 ORDER BY 1`,
    prisma.$queryRaw<any[]>`SELECT u.name, u.role, COUNT(*)::int actions FROM "OrderStatusHistory" h JOIN "User" u ON u.id=h."byUserId" WHERE h."createdAt">=${from} AND h."createdAt"<${to} GROUP BY u.name, u.role ORDER BY actions DESC LIMIT 6`,
    prisma.$queryRaw<any[]>`SELECT id, name, unit, stock, "reorderLevel" FROM "Ingredient" WHERE "reorderLevel" > 0 AND stock <= "reorderLevel" ORDER BY name LIMIT 10`,
    prisma.reservation.groupBy({ by: ['status'], where: { startAt: { gte: from, lt: to } }, _count: true }),
    prisma.auditLog.findMany({ orderBy: { createdAt: 'desc' }, take: 8, include: { user: { select: { name: true } } } }),
    prisma.refund.aggregate({ where: { createdAt: { gte: from, lt: to } }, _sum: { amount: true } }),
  ]);
  const count = (s: string) => byStatus.find((x) => x.status === s)?._count ?? 0;
  const total = byStatus.reduce((a, x) => a + x._count, 0);
  const pending = ['NEW', 'ACCEPTED', 'PREPARING', 'READY', 'OUT_FOR_DELIVERY', 'SERVED'].reduce((a, s) => a + count(s), 0);
  return {
    range: { from, to, tz },
    kpis: {
      revenue: num(completed._sum.total), refunds: num(refunds._sum.amount), netRevenue: num(completed._sum.total) - num(refunds._sum.amount),
      totalOrders: total, pendingOrders: pending, completedOrders: count('COMPLETED'), cancelledOrders: count('CANCELLED') + count('REJECTED'),
      averageOrderValue: num(completed._avg.total), discounts: num(completed._sum.discount), activeCustomers: activeCust.length,
      reservations: resv.reduce((a, r) => a + r._count, 0),
    },
    bestSellers: best.map((b) => ({ ...b, revenue: num(b.revenue) })),
    popularCategories: cats.map((b) => ({ ...b, revenue: num(b.revenue) })),
    revenueTrend: trend.map((t) => ({ day: t.day, orders: t.orders, revenue: num(t.revenue) })),
    payments: pay.map((p) => ({ ...p, amount: num(p.amount) })),
    staffPerformance: staff,
    lowStock: lowStock.map((l) => ({ ...l, stock: num(l.stock), reorderLevel: num(l.reorderLevel) })),
    reservationStatus: resv.map((r) => ({ status: r.status, count: r._count })),
    recentActivity: recent.map((r) => ({ id: r.id, action: r.action, entity: r.entity, by: r.user?.name ?? 'system', at: r.createdAt })),
  };
}

export const REPORTS = {
  'daily-sales': 'Daily sales',
  'monthly-sales': 'Monthly sales',
  'revenue-by-category': 'Revenue by category',
  'revenue-by-product': 'Revenue by product',
  'payment-methods': 'Payment methods',
  'order-types': 'Order types',
  'customer-acquisition': 'Customer acquisition',
  'repeat-customers': 'Repeat customers',
  'popular-items': 'Popular food items',
  'peak-hours': 'Peak ordering hours',
  'reservations': 'Reservation performance',
  'inventory-usage': 'Inventory usage',
  'staff-performance': 'Staff performance',
  'discounts': 'Discounts',
  'refunds': 'Refunds',
  'delivery': 'Delivery performance',
  'retention': 'Customer retention',
} as const;
export type ReportKey = keyof typeof REPORTS;

export interface ReportData { title: string; columns: string[]; rows: Array<Array<string | number>> }

export async function runReport(key: ReportKey, from: Date, to: Date, tz: string): Promise<ReportData> {
  const L = Prisma.sql`(o."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE ${tz})`;
  const done = Prisma.sql`o.status='COMPLETED' AND o."createdAt">=${from} AND o."createdAt"<${to}`;
  const t = REPORTS[key];
  const q = async (strings: Prisma.Sql) => (await prisma.$queryRaw<any[]>(strings));
  const m = (v: unknown) => Number(Number(v ?? 0).toFixed(2));
  switch (key) {
    case 'daily-sales': {
      const r = await q(Prisma.sql`SELECT to_char(${L},'YYYY-MM-DD') d, COUNT(*)::int n, SUM(o.subtotal) sub, SUM(o.discount) disc, SUM(o.tax) tax, SUM(o.total) total FROM "Order" o WHERE ${done} GROUP BY 1 ORDER BY 1`);
      return { title: t, columns: ['Date', 'Orders', 'Subtotal', 'Discounts', 'Tax', 'Total'], rows: r.map((x) => [x.d, x.n, m(x.sub), m(x.disc), m(x.tax), m(x.total)]) };
    }
    case 'monthly-sales': {
      const r = await q(Prisma.sql`SELECT to_char(${L},'YYYY-MM') d, COUNT(*)::int n, SUM(o.total) total, AVG(o.total) avg FROM "Order" o WHERE ${done} GROUP BY 1 ORDER BY 1`);
      return { title: t, columns: ['Month', 'Orders', 'Revenue', 'Avg order'], rows: r.map((x) => [x.d, x.n, m(x.total), m(x.avg)]) };
    }
    case 'revenue-by-category': {
      const r = await q(Prisma.sql`SELECT c.name, SUM(i.quantity)::int qty, SUM(i."lineTotal") rev FROM "OrderItem" i JOIN "Order" o ON o.id=i."orderId" JOIN "Product" p ON p.id=i."productId" JOIN "Category" c ON c.id=p."categoryId" WHERE ${done} GROUP BY c.name ORDER BY rev DESC`);
      return { title: t, columns: ['Category', 'Items sold', 'Revenue'], rows: r.map((x) => [x.name, x.qty, m(x.rev)]) };
    }
    case 'revenue-by-product':
    case 'popular-items': {
      const r = await q(Prisma.sql`SELECT i.name, SUM(i.quantity)::int qty, SUM(i."lineTotal") rev FROM "OrderItem" i JOIN "Order" o ON o.id=i."orderId" WHERE ${done} GROUP BY i.name ORDER BY ${key === 'popular-items' ? Prisma.sql`qty` : Prisma.sql`rev`} DESC`);
      return { title: t, columns: ['Item', 'Quantity', 'Revenue'], rows: r.map((x) => [x.name, x.qty, m(x.rev)]) };
    }
    case 'payment-methods': {
      const r = await q(Prisma.sql`SELECT p.method, p.status, COUNT(*)::int n, SUM(p.amount) amt FROM "Payment" p WHERE p."createdAt">=${from} AND p."createdAt"<${to} GROUP BY 1,2 ORDER BY 1,2`);
      return { title: t, columns: ['Method', 'Status', 'Payments', 'Amount'], rows: r.map((x) => [x.method, x.status, x.n, m(x.amt)]) };
    }
    case 'order-types': {
      const r = await q(Prisma.sql`SELECT o.type, COUNT(*)::int n, SUM(o.total) total, AVG(o.total) avg FROM "Order" o WHERE ${done} GROUP BY 1 ORDER BY 3 DESC`);
      return { title: t, columns: ['Type', 'Orders', 'Revenue', 'Avg order'], rows: r.map((x) => [x.type, x.n, m(x.total), m(x.avg)]) };
    }
    case 'customer-acquisition': {
      const r = await prisma.$queryRaw<any[]>`SELECT to_char(c."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE ${tz},'YYYY-MM-DD') d, COUNT(*)::int n FROM "Customer" c WHERE c."createdAt">=${from} AND c."createdAt"<${to} GROUP BY 1 ORDER BY 1`;
      return { title: t, columns: ['Date', 'New customers'], rows: r.map((x) => [x.d, x.n]) };
    }
    case 'repeat-customers': {
      const r = await q(Prisma.sql`SELECT c.name, COUNT(*)::int n, SUM(o.total) total, MAX(o."createdAt") AS last_at FROM "Order" o JOIN "Customer" c ON c.id=o."customerId" WHERE ${done} GROUP BY c.id, c.name HAVING COUNT(*)>=2 ORDER BY n DESC`);
      return { title: t, columns: ['Customer', 'Orders', 'Spend', 'Last order'], rows: r.map((x) => [x.name, x.n, m(x.total), new Date(x.last_at).toISOString().slice(0, 10)]) };
    }
    case 'peak-hours': {
      const r = await q(Prisma.sql`SELECT EXTRACT(HOUR FROM ${L})::int h, COUNT(*)::int n, SUM(o.total) total FROM "Order" o WHERE o.status NOT IN ('CANCELLED','REJECTED') AND o."createdAt">=${from} AND o."createdAt"<${to} GROUP BY 1 ORDER BY 1`);
      return { title: t, columns: ['Hour', 'Orders', 'Revenue'], rows: r.map((x) => [`${String(x.h).padStart(2, '0')}:00`, x.n, m(x.total)]) };
    }
    case 'reservations': {
      const r = await prisma.$queryRaw<any[]>`SELECT kind, status, COUNT(*)::int n, SUM(guests)::int guests FROM "Reservation" WHERE "startAt">=${from} AND "startAt"<${to} GROUP BY 1,2 ORDER BY 1,2`;
      return { title: t, columns: ['Kind', 'Status', 'Bookings', 'Guests'], rows: r.map((x) => [x.kind, x.status, x.n, x.guests]) };
    }
    case 'inventory-usage': {
      const r = await prisma.$queryRaw<any[]>`SELECT i.name, i.unit, SUM(CASE WHEN m.type='CONSUMPTION' THEN -m.quantity ELSE 0 END) used, SUM(CASE WHEN m.type='WASTAGE' THEN -m.quantity ELSE 0 END) wasted, SUM(CASE WHEN m.type='RECEIPT' THEN m.quantity ELSE 0 END) received FROM "StockMovement" m JOIN "Ingredient" i ON i.id=m."ingredientId" WHERE m."createdAt">=${from} AND m."createdAt"<${to} GROUP BY i.name, i.unit ORDER BY used DESC`;
      return { title: t, columns: ['Ingredient', 'Unit', 'Used', 'Wasted', 'Received'], rows: r.map((x) => [x.name, x.unit, m(x.used), m(x.wasted), m(x.received)]) };
    }
    case 'staff-performance': {
      const r = await prisma.$queryRaw<any[]>`SELECT u.name, u.role::text role, COUNT(*)::int n, COUNT(*) FILTER (WHERE h.status='COMPLETED')::int done FROM "OrderStatusHistory" h JOIN "User" u ON u.id=h."byUserId" WHERE h."createdAt">=${from} AND h."createdAt"<${to} GROUP BY u.name, u.role ORDER BY n DESC`;
      return { title: t, columns: ['Staff', 'Role', 'Status changes', 'Orders completed'], rows: r.map((x) => [x.name, x.role, x.n, x.done]) };
    }
    case 'discounts': {
      const r = await q(Prisma.sql`SELECT COALESCE(c.code,'(points/voucher/other)') code, COUNT(*)::int n, SUM(o.discount) disc, SUM(o.total) total FROM "Order" o LEFT JOIN "Coupon" c ON c.id=o."couponId" WHERE ${done} AND o.discount>0 GROUP BY 1 ORDER BY disc DESC`);
      return { title: t, columns: ['Code', 'Orders', 'Discount given', 'Order revenue'], rows: r.map((x) => [x.code, x.n, m(x.disc), m(x.total)]) };
    }
    case 'refunds': {
      const r = await prisma.$queryRaw<any[]>`SELECT r."createdAt" AS ts, o.number, p.method::text method, r.amount, r.reason FROM "Refund" r JOIN "Payment" p ON p.id=r."paymentId" JOIN "Order" o ON o.id=p."orderId" WHERE r."createdAt">=${from} AND r."createdAt"<${to} ORDER BY r."createdAt"`;
      return { title: t, columns: ['Date', 'Order', 'Method', 'Amount', 'Reason'], rows: r.map((x) => [new Date(x.ts).toISOString().slice(0, 16).replace('T', ' '), x.number, x.method, m(x.amount), x.reason ?? '']) };
    }
    case 'delivery': {
      const r = await q(Prisma.sql`SELECT COALESCE(u.name,'(unassigned)') driver, COUNT(*)::int n, ROUND(AVG(EXTRACT(EPOCH FROM (o."completedAt"-o."createdAt"))/60))::int mins, SUM(o."deliveryFee") fees FROM "Order" o LEFT JOIN "User" u ON u.id=o."driverId" WHERE o.type='DELIVERY' AND ${done} GROUP BY 1 ORDER BY n DESC`);
      return { title: t, columns: ['Driver', 'Deliveries', 'Avg minutes (order→delivered)', 'Delivery fees'], rows: r.map((x) => [x.driver, x.n, x.mins ?? 0, m(x.fees)]) };
    }
    case 'retention': {
      const r = await prisma.$queryRaw<any[]>`
        WITH first AS (SELECT "customerId" id, date_trunc('month', MIN("createdAt")) m FROM "Order" WHERE "customerId" IS NOT NULL AND status='COMPLETED' GROUP BY 1),
        ret AS (SELECT f.m, COUNT(*)::int cohort, COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM "Order" o2 WHERE o2."customerId"=f.id AND o2.status='COMPLETED' AND o2."createdAt" >= f.m + interval '1 month'))::int returned FROM first f WHERE f.m >= ${from} AND f.m < ${to} GROUP BY f.m)
        SELECT to_char(m,'YYYY-MM') d, cohort, returned FROM ret ORDER BY m`;
      return { title: t, columns: ['First-order month', 'New customers', 'Came back later', 'Retention %'], rows: r.map((x) => [x.d, x.cohort, x.returned, x.cohort ? m((x.returned / x.cohort) * 100) : 0]) };
    }
  }
}


/** Branch comparison for the same period (completed orders only). */
export async function compareOutlets(from: Date, to: Date) {
  const rows = await prisma.$queryRaw<any[]>`
    SELECT COALESCE(ou.name, 'Unassigned') AS branch, COUNT(*)::int AS orders, COALESCE(SUM(o.total),0) AS revenue,
      COALESCE(AVG(o.total),0) AS avg, COUNT(*) FILTER (WHERE o.type='DELIVERY')::int AS deliveries
    FROM "Order" o LEFT JOIN "Outlet" ou ON ou.id = o."outletId"
    WHERE o.status='COMPLETED' AND o."createdAt">=${from} AND o."createdAt"<${to}
    GROUP BY 1 ORDER BY revenue DESC`;
  return rows.map((r) => ({ branch: r.branch, orders: r.orders, revenue: Number(r.revenue), avg: Number(r.avg), deliveries: r.deliveries }));
}
