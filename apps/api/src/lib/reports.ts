import { Prisma } from '@prisma/client';
import { HttpError, prisma } from './core';

/*
 * Reports are computed in SQL from the live tables, never from cached or hard-coded numbers.
 *
 * Definitions used everywhere (and repeated in each report's notes):
 *  - A "sale" is an order that is not CANCELLED and not PENDING_PAYMENT (an online order still waiting for its payment).
 *  - Money is stored and summed in minor units (paise, cents) and only converted for display or export.
 *  - Days, months and hours are the restaurant's own local ones. Its clock is a fixed UTC offset (Settings → restaurant clock),
 *    the same for everyone who looks at a report, so two people never see different numbers for the same day.
 *    A fixed offset has no daylight-saving changes; a restaurant in a DST region must adjust it twice a year.
 */

export type ColType = 'text' | 'int' | 'money' | 'percent' | 'decimal' | 'minutes' | 'date' | 'datetime';
export interface Col { key: string; label: string; type: ColType; sum?: boolean }
export type Cell = string | number | null;
export type Row = Record<string, Cell>;
export interface ReportData {
  columns: Col[];
  rows: Row[];
  totals?: Row;
  notes?: string[];
  chart?: { kind: 'bar' | 'line'; x: string; y: string };
  mixedCurrency?: boolean; // money columns hold different currencies row by row (the outlets report)
}

export type PeriodPreset = 'today' | 'yesterday' | '7d' | '30d' | 'mtd' | 'lastMonth';
export interface PeriodSpec { preset?: PeriodPreset; from?: string; to?: string }
export interface Period { from: string; to: string; fromUtc: Date; toUtc: Date; days: number; label: string }
export interface Ctx { restaurantId: string; tenantId: string; offsetMin: number; currency: string; period: Period; spec: PeriodSpec }

const DAY = 86_400_000;
export const MAX_DAYS = 366;
const ymd = (t: number) => new Date(t).toISOString().slice(0, 10);
const parseYmd = (s: string) => Date.parse(`${s}T00:00:00Z`);

/** Turns "today / last 7 days / these two dates" into exact UTC instants for a restaurant whose local time is UTC+offsetMin. */
export function resolvePeriod(spec: PeriodSpec, offsetMin: number, now = new Date()): Period {
  const today = Math.floor((now.getTime() + offsetMin * 60_000) / DAY) * DAY; // local midnight, expressed as a UTC-based date
  let from: number, to: number;
  if (spec.from || spec.to) {
    if (!spec.from || !spec.to) throw new HttpError(400, 'Give both a start and an end date', 'validation', { from: ['Required'] });
    from = parseYmd(spec.from); to = parseYmd(spec.to);
    if (Number.isNaN(from) || Number.isNaN(to) || ymd(from) !== spec.from || ymd(to) !== spec.to) throw new HttpError(400, 'Dates must be real calendar dates (YYYY-MM-DD)', 'validation', { from: ['Invalid date'] });
  } else {
    const d = new Date(today);
    switch (spec.preset ?? '7d') {
      case 'today': from = to = today; break;
      case 'yesterday': from = to = today - DAY; break;
      case '7d': from = today - 6 * DAY; to = today; break;
      case '30d': from = today - 29 * DAY; to = today; break;
      case 'mtd': from = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); to = today; break;
      case 'lastMonth': from = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1); to = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 0); break;
      default: throw new HttpError(400, 'Unknown period', 'validation');
    }
  }
  if (from > to) throw new HttpError(400, 'The start date is after the end date', 'validation', { from: ['Must not be after the end date'] });
  const days = Math.round((to - from) / DAY) + 1;
  if (days > MAX_DAYS) throw new HttpError(400, `Choose a period of at most ${MAX_DAYS} days`, 'validation', { to: [`At most ${MAX_DAYS} days`] });
  return {
    from: ymd(from), to: ymd(to), days,
    fromUtc: new Date(from - offsetMin * 60_000), // local midnight at the start...
    toUtc: new Date(to + DAY - offsetMin * 60_000), // ...up to (not including) local midnight after the end
    label: from === to ? ymd(from) : `${ymd(from)} to ${ymd(to)}`,
  };
}

export const tzLabel = (offsetMin: number) => {
  const a = Math.abs(offsetMin);
  return `UTC${offsetMin < 0 ? '-' : '+'}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
};

// ---------- small helpers ----------
const N = (v: unknown) => Number(v ?? 0); // aggregates arrive as bigint/decimal
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : 0);
const avg = (total: number, n: number) => (n ? Math.round(total / n) : 0);
const T = (d: Date) => Prisma.sql`(${d.toISOString()}::timestamptz AT TIME ZONE 'UTC')`; // exact instant, whatever the database session's time zone
const LOCAL = (col: string, off: number) => Prisma.sql`(${Prisma.raw(col)} + make_interval(mins => ${off}::int))`;
const localDate = (d: Date, off: number) => new Date(d.getTime() + off * 60_000).toISOString().slice(0, 10);
const localStamp = (d: Date, off: number) => new Date(d.getTime() + off * 60_000).toISOString().slice(0, 16).replace('T', ' ');
const calendarDays = (p: Period) => { const out: string[] = []; for (let t = parseYmd(p.from); t <= parseYmd(p.to); t += DAY) out.push(ymd(t)); return out; };
const q = <T,>(s: Prisma.Sql) => prisma.$queryRaw<T[]>(s);
const ORDER_TYPE: Record<string, string> = { DINE_IN: 'Dine-in', TAKEAWAY: 'Takeaway', DELIVERY: 'Delivery' };

/** Orders that count as sales, inside the period, for one restaurant (alias `o`). */
const VALID = (c: Ctx) => Prisma.sql`o."restaurantId" = ${c.restaurantId} AND o."createdAt" >= ${T(c.period.fromUtc)} AND o."createdAt" < ${T(c.period.toUtc)} AND o.status::text NOT IN ('CANCELLED', 'PENDING_PAYMENT')`;
const SALE_NOTE = 'Sales exclude cancelled orders and online orders still waiting for payment.';

function withTotals(cols: Col[], rows: Row[], label = 'Total'): Row {
  const t: Row = {};
  cols.forEach((c, i) => { t[c.key] = i === 0 ? label : c.sum ? rows.reduce((s, r) => s + N(r[c.key]), 0) : null; });
  return t;
}

// ---------- 1 & 2: sales by day / month ----------
async function salesBy(c: Ctx, fmt: 'YYYY-MM-DD' | 'YYYY-MM', first: Col, buckets: string[]): Promise<ReportData> {
  const bucket = Prisma.sql`to_char(${LOCAL('o."createdAt"', c.offsetMin)}, ${fmt})`;
  const [sales, items] = await Promise.all([
    q<any>(Prisma.sql`SELECT ${bucket} AS b, COUNT(*)::int AS orders, COALESCE(SUM(o."subtotalCents"),0) AS gross, COALESCE(SUM(o."discountCents"),0) AS discounts,
      COALESCE(SUM(o."taxCents"),0) AS tax, COALESCE(SUM(o."serviceCents"),0) AS service, COALESCE(SUM(o."deliveryCents"),0) AS delivery,
      COALESCE(SUM(o."tipCents"),0) AS tips, COALESCE(SUM(o."totalCents"),0) AS total FROM "Order" o WHERE ${VALID(c)} GROUP BY 1`),
    q<any>(Prisma.sql`SELECT ${bucket} AS b, SUM(oi.quantity)::int AS items FROM "OrderItem" oi JOIN "Order" o ON o.id = oi."orderId" WHERE ${VALID(c)} GROUP BY 1`),
  ]);
  const byB = new Map(sales.map((r) => [r.b as string, r]));
  const itemsB = new Map(items.map((r) => [r.b as string, N(r.items)]));
  const columns: Col[] = [first,
    { key: 'orders', label: 'Orders', type: 'int', sum: true }, { key: 'items', label: 'Items', type: 'int', sum: true },
    { key: 'gross', label: 'Item sales', type: 'money', sum: true }, { key: 'discounts', label: 'Discounts', type: 'money', sum: true },
    { key: 'tax', label: 'Tax', type: 'money', sum: true }, { key: 'service', label: 'Service charge', type: 'money', sum: true },
    { key: 'delivery', label: 'Delivery fees', type: 'money', sum: true }, { key: 'tips', label: 'Tips', type: 'money', sum: true },
    { key: 'total', label: 'Order total', type: 'money', sum: true }, { key: 'avg', label: 'Average order', type: 'money' }];
  const rows: Row[] = buckets.map((b) => {
    const r = byB.get(b); const orders = N(r?.orders); const total = N(r?.total);
    return { [first.key]: b, orders, items: itemsB.get(b) ?? 0, gross: N(r?.gross), discounts: N(r?.discounts), tax: N(r?.tax), service: N(r?.service), delivery: N(r?.delivery), tips: N(r?.tips), total, avg: avg(total, orders) };
  });
  const totals = withTotals(columns, rows);
  totals.avg = avg(N(totals.total), N(totals.orders));
  return { columns, rows, totals, chart: { kind: fmt === 'YYYY-MM' ? 'bar' : 'line', x: first.key, y: 'total' },
    notes: [SALE_NOTE, 'Order total = item sales − discounts + tax + service charge + delivery fees + tips.'] };
}

// ---------- 3 & 4: by category / product ----------
const ITEM_NOTE = 'Item sales are what was sold before order-level discounts, tax, service charge and tips.';

async function byCategory(c: Ctx): Promise<ReportData> {
  const rows = await q<any>(Prisma.sql`SELECT COALESCE(cat.name, 'Uncategorised') AS category, SUM(oi.quantity)::int AS qty, SUM(oi."unitPriceCents" * oi.quantity) AS revenue
    FROM "OrderItem" oi JOIN "Order" o ON o.id = oi."orderId" LEFT JOIN "Product" p ON p.id = oi."productId" LEFT JOIN "Category" cat ON cat.id = p."categoryId"
    WHERE ${VALID(c)} GROUP BY 1 ORDER BY revenue DESC, category`);
  const total = rows.reduce((s, r) => s + N(r.revenue), 0);
  const columns: Col[] = [{ key: 'category', label: 'Category', type: 'text' }, { key: 'qty', label: 'Items sold', type: 'int', sum: true }, { key: 'revenue', label: 'Item sales', type: 'money', sum: true }, { key: 'share', label: 'Share of sales', type: 'percent' }];
  const out: Row[] = rows.map((r) => ({ category: r.category, qty: N(r.qty), revenue: N(r.revenue), share: pct(N(r.revenue), total) }));
  return { columns, rows: out, totals: { ...withTotals(columns, out), share: out.length ? 100 : 0 }, chart: { kind: 'bar', x: 'category', y: 'revenue' },
    notes: [SALE_NOTE, ITEM_NOTE, '"Uncategorised" covers menu items that have since been deleted.'] };
}

async function byProduct(c: Ctx): Promise<ReportData> {
  const rows = await q<any>(Prisma.sql`SELECT MAX(oi.name) AS product, SUM(oi.quantity)::int AS qty, SUM(oi."unitPriceCents" * oi.quantity) AS revenue
    FROM "OrderItem" oi JOIN "Order" o ON o.id = oi."orderId" WHERE ${VALID(c)} GROUP BY COALESCE(oi."productId", oi.name) ORDER BY qty DESC, revenue DESC, product LIMIT 1000`);
  const total = rows.reduce((s, r) => s + N(r.revenue), 0);
  const columns: Col[] = [{ key: 'product', label: 'Item', type: 'text' }, { key: 'qty', label: 'Quantity sold', type: 'int', sum: true }, { key: 'revenue', label: 'Item sales', type: 'money', sum: true }, { key: 'avgPrice', label: 'Average price', type: 'money' }, { key: 'share', label: 'Share of sales', type: 'percent' }];
  const out: Row[] = rows.map((r) => ({ product: r.product, qty: N(r.qty), revenue: N(r.revenue), avgPrice: avg(N(r.revenue), N(r.qty)), share: pct(N(r.revenue), total) }));
  const t = withTotals(columns, out); t.avgPrice = avg(N(t.revenue), N(t.qty)); t.share = out.length ? 100 : 0;
  return { columns, rows: out, totals: t, chart: { kind: 'bar', x: 'product', y: 'qty' }, notes: [SALE_NOTE, ITEM_NOTE, 'Ranked by quantity sold (the most popular items first). The first 1,000 items are shown.'] };
}

// ---------- 5: payment methods ----------
async function payments(c: Ctx): Promise<ReportData> {
  const PAID = Prisma.sql`o."paymentStatus"::text IN ('PAID', 'PARTIALLY_REFUNDED', 'REFUNDED')`;
  const [rows, onlineRefunds] = await Promise.all([
    q<any>(Prisma.sql`SELECT o."paymentMethod" AS method, COUNT(*)::int AS orders, COALESCE(SUM(o."totalCents"),0) AS total,
      COALESCE(SUM(o."totalCents") FILTER (WHERE ${PAID}),0) AS collected,
      COALESCE(SUM(o."totalCents") FILTER (WHERE o."paymentMethod" = 'CASH' AND o."paymentStatus"::text = 'REFUNDED'),0) AS cash_refunded
      FROM "Order" o WHERE ${VALID(c)} GROUP BY 1`),
    q<any>(Prisma.sql`SELECT COALESCE(SUM(r."amountCents"),0) AS refunded FROM "Refund" r JOIN "Payment" p ON p.id = r."paymentId" JOIN "Order" o ON o.id = p."orderId" WHERE ${VALID(c)}`),
  ]);
  const online = N(onlineRefunds[0]?.refunded);
  const columns: Col[] = [{ key: 'method', label: 'Payment method', type: 'text' }, { key: 'orders', label: 'Orders', type: 'int', sum: true }, { key: 'total', label: 'Order total', type: 'money', sum: true },
    { key: 'collected', label: 'Collected', type: 'money', sum: true }, { key: 'outstanding', label: 'Not yet paid', type: 'money', sum: true }, { key: 'refunded', label: 'Refunded', type: 'money', sum: true }, { key: 'net', label: 'Net collected', type: 'money', sum: true }];
  const out: Row[] = ['CASH', 'ONLINE'].map((m) => {
    const r = rows.find((x) => x.method === m);
    const total = N(r?.total), collected = N(r?.collected);
    const refunded = m === 'CASH' ? N(r?.cash_refunded) : online;
    return { method: m === 'CASH' ? 'Cash (at the restaurant or on delivery)' : 'Online', orders: N(r?.orders), total, collected, outstanding: total - collected, refunded, net: collected - refunded };
  });
  return { columns, rows: out, totals: withTotals(columns, out), chart: { kind: 'bar', x: 'method', y: 'total' },
    notes: [SALE_NOTE, '"Collected" counts orders marked paid (cash orders are marked paid by staff). "Refunded" covers refunds on the orders in this period, whenever the refund was made.'] };
}

// ---------- 6: order types ----------
async function orderTypes(c: Ctx): Promise<ReportData> {
  const rows = await q<any>(Prisma.sql`SELECT o.type::text AS type, COUNT(*)::int AS orders, COALESCE(SUM(o."totalCents"),0) AS total FROM "Order" o WHERE ${VALID(c)} GROUP BY 1`);
  const orders = rows.reduce((s, r) => s + N(r.orders), 0), total = rows.reduce((s, r) => s + N(r.total), 0);
  const columns: Col[] = [{ key: 'type', label: 'Order type', type: 'text' }, { key: 'orders', label: 'Orders', type: 'int', sum: true }, { key: 'orderShare', label: 'Share of orders', type: 'percent' }, { key: 'total', label: 'Order total', type: 'money', sum: true }, { key: 'revShare', label: 'Share of sales', type: 'percent' }, { key: 'avg', label: 'Average order', type: 'money' }];
  const out: Row[] = ['DINE_IN', 'TAKEAWAY', 'DELIVERY'].map((t) => { const r = rows.find((x) => x.type === t); const o = N(r?.orders), tot = N(r?.total); return { type: ORDER_TYPE[t], orders: o, orderShare: pct(o, orders), total: tot, revShare: pct(tot, total), avg: avg(tot, o) }; });
  const t = withTotals(columns, out); t.orderShare = orders ? 100 : 0; t.revShare = total ? 100 : 0; t.avg = avg(total, orders);
  return { columns, rows: out, totals: t, chart: { kind: 'bar', x: 'type', y: 'total' }, notes: [SALE_NOTE] };
}

// ---------- 7: peak hours ----------
async function peakHours(c: Ctx): Promise<ReportData> {
  const rows = await q<any>(Prisma.sql`SELECT EXTRACT(HOUR FROM ${LOCAL('o."createdAt"', c.offsetMin)})::int AS h, COUNT(*)::int AS orders, COALESCE(SUM(o."totalCents"),0) AS total FROM "Order" o WHERE ${VALID(c)} GROUP BY 1`);
  const orders = rows.reduce((s, r) => s + N(r.orders), 0);
  const columns: Col[] = [{ key: 'hour', label: 'Hour of day', type: 'text' }, { key: 'orders', label: 'Orders', type: 'int', sum: true }, { key: 'share', label: 'Share of orders', type: 'percent' }, { key: 'total', label: 'Order total', type: 'money', sum: true }, { key: 'avg', label: 'Average order', type: 'money' }];
  const out: Row[] = Array.from({ length: 24 }, (_, h) => { const r = rows.find((x) => N(x.h) === h); const o = N(r?.orders), tot = N(r?.total); return { hour: `${String(h).padStart(2, '0')}:00–${String((h + 1) % 24).padStart(2, '0')}:00`, orders: o, share: pct(o, orders), total: tot, avg: avg(tot, o) }; });
  const t = withTotals(columns, out); t.share = orders ? 100 : 0; t.avg = avg(N(t.total), N(t.orders));
  return { columns, rows: out, totals: t, chart: { kind: 'bar', x: 'hour', y: 'orders' }, notes: [SALE_NOTE, 'Hours are the time the order was placed, in the restaurant\'s local time.'] };
}

// ---------- 8: customer acquisition ----------
async function acquisition(c: Ctx): Promise<ReportData> {
  const day = Prisma.sql`to_char(${LOCAL('"createdAt"', c.offsetMin)}, 'YYYY-MM-DD')`;
  const [fresh, active, stats] = await Promise.all([
    q<any>(Prisma.sql`SELECT ${day} AS d, COUNT(*)::int AS n, COUNT(*) FILTER (WHERE "marketingConsent" AND "optedOutAt" IS NULL)::int AS optin FROM "Customer" WHERE "restaurantId" = ${c.restaurantId} AND "createdAt" >= ${T(c.period.fromUtc)} AND "createdAt" < ${T(c.period.toUtc)} GROUP BY 1`),
    q<any>(Prisma.sql`SELECT to_char(${LOCAL('o."createdAt"', c.offsetMin)}, 'YYYY-MM-DD') AS d, COUNT(DISTINCT o."customerId")::int AS n FROM "Order" o WHERE ${VALID(c)} AND o."customerId" IS NOT NULL GROUP BY 1`),
    q<any>(Prisma.sql`SELECT COUNT(DISTINCT o."customerId")::int AS ordering,
      COUNT(DISTINCT o."customerId") FILTER (WHERE EXISTS (SELECT 1 FROM "Order" b WHERE b."customerId" = o."customerId" AND b."createdAt" < ${T(c.period.fromUtc)} AND b.status::text NOT IN ('CANCELLED','PENDING_PAYMENT')))::int AS returning
      FROM "Order" o WHERE ${VALID(c)} AND o."customerId" IS NOT NULL`),
  ]);
  const f = new Map(fresh.map((r) => [r.d as string, r])), a = new Map(active.map((r) => [r.d as string, N(r.n)]));
  const columns: Col[] = [{ key: 'date', label: 'Date', type: 'date' }, { key: 'fresh', label: 'New customers', type: 'int', sum: true }, { key: 'optin', label: 'Agreed to marketing', type: 'int', sum: true }, { key: 'active', label: 'Customers who ordered', type: 'int' }];
  const rows: Row[] = calendarDays(c.period).map((d) => ({ date: d, fresh: N(f.get(d)?.n), optin: N(f.get(d)?.optin), active: a.get(d) ?? 0 }));
  const s = stats[0] ?? {}; const ordering = N(s.ordering), returning = N(s.returning);
  const totals = withTotals(columns, rows); totals.active = ordering;
  return { columns, rows, totals, chart: { kind: 'bar', x: 'date', y: 'fresh' },
    notes: [`${ordering} different customers ordered in this period; ${returning} (${pct(returning, ordering)}%) had already ordered before it and ${ordering - returning} were first-time buyers.`,
      '"Customers who ordered" in the Total row counts each customer once; the daily figures count customers per day.', 'A customer is new on the day their profile was first created (their first order).'] };
}

async function repeatCustomers(c: Ctx): Promise<ReportData> {
  const [rows, total] = await Promise.all([
    q<any>(Prisma.sql`SELECT cu.name, cu.phone, COUNT(*)::int AS orders, SUM(o."totalCents") AS spent, MIN(o."createdAt") AS first, MAX(o."createdAt") AS last
      FROM "Order" o JOIN "Customer" cu ON cu.id = o."customerId" WHERE ${VALID(c)} GROUP BY cu.id HAVING COUNT(*) >= 2 ORDER BY orders DESC, spent DESC LIMIT 500`),
    q<any>(Prisma.sql`SELECT COUNT(DISTINCT o."customerId")::int AS n FROM "Order" o WHERE ${VALID(c)} AND o."customerId" IS NOT NULL`),
  ]);
  const columns: Col[] = [{ key: 'name', label: 'Customer', type: 'text' }, { key: 'phone', label: 'Phone', type: 'text' }, { key: 'orders', label: 'Orders', type: 'int', sum: true }, { key: 'spent', label: 'Total spent', type: 'money', sum: true }, { key: 'avg', label: 'Average order', type: 'money' }, { key: 'first', label: 'First order', type: 'date' }, { key: 'last', label: 'Last order', type: 'date' }];
  const out: Row[] = rows.map((r) => ({ name: r.name, phone: r.phone, orders: N(r.orders), spent: N(r.spent), avg: avg(N(r.spent), N(r.orders)), first: localDate(r.first, c.offsetMin), last: localDate(r.last, c.offsetMin) }));
  const t = withTotals(columns, out); t.avg = avg(N(t.spent), N(t.orders));
  const ordering = N(total[0]?.n);
  return { columns, rows: out, totals: t, notes: [`${out.length} of ${ordering} customers who ordered in this period ordered at least twice (${pct(out.length, ordering)}% repeat rate). Up to 500 customers are listed.`, 'Contains personal data: share it only with people who need it.'] };
}

// ---------- 9: reservations ----------
async function reservations(c: Ctx): Promise<ReportData> {
  const rows = await q<any>(Prisma.sql`SELECT to_char(${LOCAL('r."startsAt"', c.offsetMin)}, 'YYYY-MM-DD') AS d, COUNT(*)::int AS bookings,
    COUNT(*) FILTER (WHERE r.status::text = 'CONFIRMED')::int AS confirmed, COUNT(*) FILTER (WHERE r.status::text = 'COMPLETED')::int AS completed,
    COUNT(*) FILTER (WHERE r.status::text = 'CANCELLED')::int AS cancelled, COUNT(*) FILTER (WHERE r.status::text = 'NO_SHOW')::int AS noshow,
    COALESCE(SUM(r."partySize") FILTER (WHERE r.status::text IN ('CONFIRMED', 'COMPLETED')),0) AS guests
    FROM "Reservation" r WHERE r."restaurantId" = ${c.restaurantId} AND r."startsAt" >= ${T(c.period.fromUtc)} AND r."startsAt" < ${T(c.period.toUtc)} GROUP BY 1`);
  const byD = new Map(rows.map((r) => [r.d as string, r]));
  const columns: Col[] = [{ key: 'date', label: 'Date', type: 'date' }, { key: 'bookings', label: 'Bookings', type: 'int', sum: true }, { key: 'confirmed', label: 'Upcoming', type: 'int', sum: true }, { key: 'completed', label: 'Seated', type: 'int', sum: true },
    { key: 'cancelled', label: 'Cancelled', type: 'int', sum: true }, { key: 'noshow', label: 'No-shows', type: 'int', sum: true }, { key: 'guests', label: 'Guests (not cancelled)', type: 'int', sum: true }, { key: 'noshowRate', label: 'No-show rate', type: 'percent' }];
  const out: Row[] = calendarDays(c.period).map((d) => { const r = byD.get(d); const seated = N(r?.completed), ns = N(r?.noshow); return { date: d, bookings: N(r?.bookings), confirmed: N(r?.confirmed), completed: seated, cancelled: N(r?.cancelled), noshow: ns, guests: N(r?.guests), noshowRate: pct(ns, seated + ns) }; });
  const t = withTotals(columns, out); t.noshowRate = pct(N(t.noshow), N(t.completed) + N(t.noshow));
  return { columns, rows: out, totals: t, chart: { kind: 'bar', x: 'date', y: 'bookings' }, notes: ['Counted by the day of the booking (not the day it was made), in the restaurant\'s local time.', 'No-show rate = no-shows ÷ (seated + no-shows): bookings whose outcome is known.'] };
}

// ---------- 10: inventory usage ----------
async function inventoryUsage(c: Ctx): Promise<ReportData> {
  const rows = await q<any>(Prisma.sql`SELECT i.name, i.unit, i."stockQty" AS closing,
    COALESCE(SUM(m.delta) FILTER (WHERE m.reason::text = 'PURCHASE'),0) AS purchased, COALESCE(-SUM(m.delta) FILTER (WHERE m.reason::text = 'ORDER'),0) AS consumed,
    COALESCE(-SUM(m.delta) FILTER (WHERE m.reason::text = 'WASTAGE'),0) AS wastage, COALESCE(SUM(m.delta) FILTER (WHERE m.reason::text = 'ADJUSTMENT'),0) AS adjustments
    FROM "Ingredient" i LEFT JOIN "StockMovement" m ON m."ingredientId" = i.id AND m."createdAt" >= ${T(c.period.fromUtc)} AND m."createdAt" < ${T(c.period.toUtc)}
    WHERE i."restaurantId" = ${c.restaurantId} GROUP BY i.id ORDER BY consumed DESC, i.name`);
  const columns: Col[] = [{ key: 'name', label: 'Ingredient', type: 'text' }, { key: 'unit', label: 'Unit', type: 'text' }, { key: 'purchased', label: 'Received', type: 'decimal' }, { key: 'consumed', label: 'Used in orders', type: 'decimal' },
    { key: 'wastage', label: 'Wastage', type: 'decimal' }, { key: 'adjustments', label: 'Count adjustments', type: 'decimal' }, { key: 'closing', label: 'In stock now', type: 'decimal' }];
  const out: Row[] = rows.map((r) => ({ name: r.name, unit: r.unit, purchased: N(r.purchased), consumed: N(r.consumed), wastage: N(r.wastage), adjustments: N(r.adjustments), closing: N(r.closing) }));
  return { columns, rows: out, notes: ['Quantities are in each ingredient\'s own unit, so they are not added together.', '"In stock now" is today\'s balance, not the balance at the end of the period.', 'Orders only use up stock for menu items that have a recipe.'] };
}

// ---------- 11: staff performance ----------
async function staffPerformance(c: Ctx): Promise<ReportData> {
  const rows = await q<any>(Prisma.sql`SELECT u.name, u.role::text AS role,
    COUNT(*) FILTER (WHERE h.status::text = 'ACCEPTED')::int AS accepted, COUNT(*) FILTER (WHERE h.status::text = 'READY')::int AS ready,
    COUNT(*) FILTER (WHERE h.status::text IN ('SERVED', 'OUT_FOR_DELIVERY'))::int AS dispatched, COUNT(*) FILTER (WHERE h.status::text = 'COMPLETED')::int AS completed,
    COUNT(*) FILTER (WHERE h.status::text = 'CANCELLED')::int AS cancelled,
    AVG(EXTRACT(EPOCH FROM (h."createdAt" - a."createdAt")) / 60) FILTER (WHERE h.status::text = 'READY' AND a."createdAt" IS NOT NULL) AS prep
    FROM "OrderStatusHistory" h JOIN "Order" o ON o.id = h."orderId" JOIN "User" u ON u.id = h."actorId"
    LEFT JOIN "OrderStatusHistory" a ON a."orderId" = h."orderId" AND a.status::text = 'ACCEPTED'
    WHERE o."restaurantId" = ${c.restaurantId} AND h."createdAt" >= ${T(c.period.fromUtc)} AND h."createdAt" < ${T(c.period.toUtc)} GROUP BY u.id ORDER BY (COUNT(*)) DESC, u.name`);
  const columns: Col[] = [{ key: 'name', label: 'Staff member', type: 'text' }, { key: 'role', label: 'Role', type: 'text' }, { key: 'accepted', label: 'Orders accepted', type: 'int', sum: true }, { key: 'ready', label: 'Marked ready', type: 'int', sum: true },
    { key: 'dispatched', label: 'Served / sent out', type: 'int', sum: true }, { key: 'completed', label: 'Completed', type: 'int', sum: true }, { key: 'cancelled', label: 'Cancelled', type: 'int', sum: true }, { key: 'prep', label: 'Avg. prep time', type: 'minutes' }];
  const out: Row[] = rows.map((r) => ({ name: r.name, role: String(r.role).charAt(0) + String(r.role).slice(1).toLowerCase(), accepted: N(r.accepted), ready: N(r.ready), dispatched: N(r.dispatched), completed: N(r.completed), cancelled: N(r.cancelled), prep: r.prep == null ? null : Math.round(N(r.prep) * 10) / 10 }));
  return { columns, rows: out, totals: withTotals(columns, out), notes: ['Counts the status changes each person made on this outlet\'s orders in the period.', 'Avg. prep time is the time from "accepted" to "ready" on the orders this person marked ready; it reflects the whole kitchen, not just one person.', 'It measures activity, not quality: use it as a conversation starter, not a score.'] };
}

// ---------- 12 & 13: discounts and refunds ----------
async function discounts(c: Ctx): Promise<ReportData> {
  const [rows, all] = await Promise.all([
    q<any>(Prisma.sql`SELECT COALESCE(o."couponCode", '(no code)') AS code, COUNT(*)::int AS orders, SUM(o."discountCents") AS discount, SUM(o."subtotalCents") AS gross, SUM(o."totalCents") AS total
      FROM "Order" o WHERE ${VALID(c)} AND o."discountCents" > 0 GROUP BY 1 ORDER BY discount DESC, code`),
    q<any>(Prisma.sql`SELECT COUNT(*)::int AS orders, COALESCE(SUM(o."subtotalCents"),0) AS gross FROM "Order" o WHERE ${VALID(c)}`),
  ]);
  const totalDiscount = rows.reduce((s, r) => s + N(r.discount), 0);
  const columns: Col[] = [{ key: 'code', label: 'Coupon / voucher code', type: 'text' }, { key: 'orders', label: 'Orders', type: 'int', sum: true }, { key: 'discount', label: 'Discount given', type: 'money', sum: true }, { key: 'share', label: 'Share of discounts', type: 'percent' },
    { key: 'avgDiscount', label: 'Average discount', type: 'money' }, { key: 'pctOfSales', label: 'Discount as % of item sales', type: 'percent' }, { key: 'total', label: 'Order total after discount', type: 'money', sum: true }];
  const out: Row[] = rows.map((r) => ({ code: r.code, orders: N(r.orders), discount: N(r.discount), share: pct(N(r.discount), totalDiscount), avgDiscount: avg(N(r.discount), N(r.orders)), pctOfSales: pct(N(r.discount), N(r.gross)), total: N(r.total) }));
  const t = withTotals(columns, out); t.share = out.length ? 100 : 0; t.avgDiscount = avg(totalDiscount, N(t.orders)); t.pctOfSales = pct(totalDiscount, N(all[0]?.gross));
  return { columns, rows: out, totals: t, chart: { kind: 'bar', x: 'code', y: 'discount' }, notes: [SALE_NOTE, `Of ${N(all[0]?.orders)} orders in the period, ${N(t.orders)} used a discount. Loyalty vouchers and birthday offers appear under their own codes.`] };
}

async function refunds(c: Ctx): Promise<ReportData> {
  const [online, manual] = await Promise.all([
    q<any>(Prisma.sql`SELECT r."createdAt" AS at, o.number, o."customerName" AS customer, r."amountCents" AS amount, r.reason, p.provider, u.name AS by
      FROM "Refund" r JOIN "Payment" p ON p.id = r."paymentId" JOIN "Order" o ON o.id = p."orderId" LEFT JOIN "User" u ON u.id = r."actorId"
      WHERE p."restaurantId" = ${c.restaurantId} AND r."createdAt" >= ${T(c.period.fromUtc)} AND r."createdAt" < ${T(c.period.toUtc)}`),
    q<any>(Prisma.sql`SELECT a."createdAt" AS at, o.number, o."customerName" AS customer, o."totalCents" AS amount, u.name AS by
      FROM "AuditLog" a JOIN "Order" o ON o.id = a.detail->>'orderId' LEFT JOIN "User" u ON u.id = a."actorId"
      WHERE a."restaurantId" = ${c.restaurantId} AND a.action = 'order.payment.refunded' AND a."createdAt" >= ${T(c.period.fromUtc)} AND a."createdAt" < ${T(c.period.toUtc)}`),
  ]);
  const all = [
    ...online.map((r) => ({ at: r.at as Date, number: N(r.number), customer: r.customer, method: `Online (${r.provider})`, amount: N(r.amount), reason: r.reason ?? '', by: r.by ?? '' })),
    ...manual.map((r) => ({ at: r.at as Date, number: N(r.number), customer: r.customer, method: 'Cash (marked refunded)', amount: N(r.amount), reason: '', by: r.by ?? '' })),
  ].sort((x, y) => y.at.getTime() - x.at.getTime());
  const columns: Col[] = [{ key: 'at', label: 'When', type: 'datetime' }, { key: 'number', label: 'Order #', type: 'int' }, { key: 'customer', label: 'Customer', type: 'text' }, { key: 'method', label: 'Method', type: 'text' }, { key: 'amount', label: 'Amount refunded', type: 'money', sum: true }, { key: 'reason', label: 'Reason', type: 'text' }, { key: 'by', label: 'Done by', type: 'text' }];
  const rows: Row[] = all.map((r) => ({ ...r, at: localStamp(r.at, c.offsetMin) }));
  return { columns, rows, totals: withTotals(columns, rows), notes: ['Listed by the day the refund was made (unlike the payment-methods report, which groups refunds by the order\'s day).', 'A cash order marked "refunded" is recorded at its full order total; online refunds can be partial.'] };
}

// ---------- 14: outlets (whole business) ----------
async function outlets(c: Ctx): Promise<ReportData> {
  const list = await prisma.restaurant.findMany({ where: { tenantId: c.tenantId }, orderBy: { createdAt: 'asc' } });
  const rows: Row[] = [];
  for (const r of list) {
    const p = resolvePeriod(c.spec, r.utcOffsetMinutes); // each outlet's own clock decides where its days begin and end
    const oc: Ctx = { ...c, restaurantId: r.id, offsetMin: r.utcOffsetMinutes, currency: r.currency, period: p };
    const [s, cancelled, ref, res] = await Promise.all([
      q<any>(Prisma.sql`SELECT COUNT(*)::int AS orders, COALESCE(SUM(o."totalCents"),0) AS total, COALESCE(SUM(o."discountCents"),0) AS discounts FROM "Order" o WHERE ${VALID(oc)}`),
      q<any>(Prisma.sql`SELECT COUNT(*)::int AS n FROM "Order" o WHERE o."restaurantId" = ${r.id} AND o."createdAt" >= ${T(p.fromUtc)} AND o."createdAt" < ${T(p.toUtc)} AND o.status::text = 'CANCELLED'`),
      q<any>(Prisma.sql`SELECT COALESCE(SUM(x."amountCents"),0) AS n FROM "Refund" x JOIN "Payment" p ON p.id = x."paymentId" WHERE p."restaurantId" = ${r.id} AND x."createdAt" >= ${T(p.fromUtc)} AND x."createdAt" < ${T(p.toUtc)}`),
      q<any>(Prisma.sql`SELECT COUNT(*)::int AS n FROM "Reservation" x WHERE x."restaurantId" = ${r.id} AND x."startsAt" >= ${T(p.fromUtc)} AND x."startsAt" < ${T(p.toUtc)} AND x.status::text <> 'CANCELLED'`),
    ]);
    const orders = N(s[0]?.orders), total = N(s[0]?.total);
    rows.push({ outlet: r.name, currency: r.currency, orders, total, avg: avg(total, orders), discounts: N(s[0]?.discounts), refunded: N(ref[0]?.n), cancelled: N(cancelled[0]?.n), reservations: N(res[0]?.n) });
  }
  const columns: Col[] = [{ key: 'outlet', label: 'Outlet', type: 'text' }, { key: 'currency', label: 'Currency', type: 'text' }, { key: 'orders', label: 'Orders', type: 'int', sum: true }, { key: 'total', label: 'Order total', type: 'money', sum: true }, { key: 'avg', label: 'Average order', type: 'money' },
    { key: 'discounts', label: 'Discounts', type: 'money', sum: true }, { key: 'refunded', label: 'Online refunds', type: 'money', sum: true }, { key: 'cancelled', label: 'Cancelled orders', type: 'int', sum: true }, { key: 'reservations', label: 'Reservations', type: 'int', sum: true }];
  const mixed = new Set(rows.map((r) => r.currency)).size > 1;
  const t = withTotals(columns, rows); t.avg = avg(N(t.total), N(t.orders));
  const notes = [SALE_NOTE, 'Each outlet\'s days follow its own clock.'];
  if (mixed) { for (const k of ['total', 'discounts', 'refunded', 'avg']) t[k] = null; notes.push('Outlets use different currencies, so money is not added up across them.'); }
  return { columns, rows, totals: t, mixedCurrency: mixed, chart: mixed ? undefined : { kind: 'bar', x: 'outlet', y: 'total' }, notes };
}

// ---------- catalogue ----------
export interface ReportDef { key: string; title: string; description: string; group: 'Sales' | 'Customers' | 'Operations' | 'Finance'; tier: 'basic' | 'advanced'; ownerOnly?: boolean; run: (c: Ctx) => Promise<ReportData> }

export const REPORTS: ReportDef[] = [
  { key: 'sales-daily', title: 'Daily sales', description: 'Orders, item sales, discounts, tax, tips and totals for every day.', group: 'Sales', tier: 'basic', run: (c) => salesBy(c, 'YYYY-MM-DD', { key: 'date', label: 'Date', type: 'date' }, calendarDays(c.period)) },
  { key: 'sales-monthly', title: 'Monthly sales', description: 'The same figures grouped by calendar month.', group: 'Sales', tier: 'basic', run: (c) => salesBy(c, 'YYYY-MM', { key: 'month', label: 'Month', type: 'text' }, [...new Set(calendarDays(c.period).map((d) => d.slice(0, 7)))]) },
  { key: 'products', title: 'Popular items', description: 'What sells most, by quantity and by sales.', group: 'Sales', tier: 'basic', run: byProduct },
  { key: 'categories', title: 'Sales by category', description: 'Which parts of the menu earn the most.', group: 'Sales', tier: 'advanced', run: byCategory },
  { key: 'order-types', title: 'Order types', description: 'Dine-in, takeaway and delivery compared.', group: 'Sales', tier: 'basic', run: orderTypes },
  { key: 'peak-hours', title: 'Peak ordering hours', description: 'When customers order during the day.', group: 'Operations', tier: 'basic', run: peakHours },
  { key: 'payments', title: 'Payment methods', description: 'Cash and online: collected, outstanding and refunded.', group: 'Finance', tier: 'basic', run: payments },
  { key: 'discounts', title: 'Discounts', description: 'What each coupon and voucher cost you.', group: 'Finance', tier: 'basic', run: discounts },
  { key: 'refunds', title: 'Refunds', description: 'Every refund in the period, who made it and why.', group: 'Finance', tier: 'advanced', run: refunds },
  { key: 'customer-acquisition', title: 'Customer acquisition', description: 'New customers per day and how many were returning.', group: 'Customers', tier: 'advanced', run: acquisition },
  { key: 'repeat-customers', title: 'Repeat customers', description: 'Customers who ordered more than once, and the repeat rate.', group: 'Customers', tier: 'advanced', run: repeatCustomers },
  { key: 'reservations', title: 'Reservation performance', description: 'Bookings, seatings, cancellations and no-shows.', group: 'Operations', tier: 'advanced', run: reservations },
  { key: 'inventory-usage', title: 'Inventory usage', description: 'Stock received, used, wasted and adjusted.', group: 'Operations', tier: 'advanced', run: inventoryUsage },
  { key: 'staff-performance', title: 'Staff activity', description: 'Orders handled by each team member and kitchen prep time.', group: 'Operations', tier: 'advanced', run: staffPerformance },
  { key: 'outlets', title: 'Revenue by outlet', description: 'All your outlets side by side.', group: 'Sales', tier: 'advanced', ownerOnly: true, run: outlets },
];

export const findReport = (key: string) => REPORTS.find((r) => r.key === key);

export async function buildReport(def: ReportDef, restaurantId: string, spec: PeriodSpec, now = new Date()) {
  const r = await prisma.restaurant.findUniqueOrThrow({ where: { id: restaurantId } });
  const period = resolvePeriod(spec, r.utcOffsetMinutes, now);
  const data = await def.run({ restaurantId, tenantId: r.tenantId, offsetMin: r.utcOffsetMinutes, currency: r.currency, period, spec });
  return {
    key: def.key, title: def.title, description: def.description, group: def.group, tier: def.tier,
    restaurant: r.name, currency: r.currency, timezone: tzLabel(r.utcOffsetMinutes), period: { from: period.from, to: period.to, label: period.label, days: period.days }, generatedAt: now.toISOString(),
    columns: data.columns, rows: data.rows, totals: data.totals ?? null, notes: data.notes ?? [], chart: data.chart ?? null, mixedCurrency: !!data.mixedCurrency,
  };
}
export type BuiltReport = Awaited<ReturnType<typeof buildReport>>;
