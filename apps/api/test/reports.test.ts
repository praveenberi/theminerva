import { describe, expect, it, beforeAll } from 'vitest';
import request from 'supertest';
import ExcelJS from 'exceljs';
import { unzipSync } from 'fflate';
import { createApp } from '../src/app';
import { prisma } from '../src/lib/core';
import { resolvePeriod } from '../src/lib/reports';
import { toCsv } from '../src/lib/exporters';

const app = createApp();
const uid = Date.now().toString(36);
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

async function signup(tag: string) {
  const r = await request(app).post('/api/auth/register').send({ restaurantName: `Rep ${tag} ${uid}`, name: 'Owner', email: `rep-${tag}-${uid}@example.com`, password: 'Password123!' });
  expect(r.status).toBe(201);
  const restaurant = await prisma.restaurant.findUniqueOrThrow({ where: { id: r.body.restaurant.id } });
  return { auth: bearer(r.body.accessToken), slug: restaurant.slug, restaurantId: restaurant.id, tenantId: restaurant.tenantId };
}

describe('report periods', () => {
  const now = new Date('2026-11-04T20:00:00Z'); // 01:30 on 5 November in India
  it('uses the restaurant clock to decide what "today" is', () => {
    expect(resolvePeriod({ preset: 'today' }, 330, now)).toMatchObject({ from: '2026-11-05', to: '2026-11-05', days: 1 });
    expect(resolvePeriod({ preset: 'today' }, 0, now)).toMatchObject({ from: '2026-11-04', to: '2026-11-04' });
    expect(resolvePeriod({ preset: 'today' }, -300, now)).toMatchObject({ from: '2026-11-04', to: '2026-11-04' });
  });
  it('turns local days into exact UTC instants', () => {
    const p = resolvePeriod({ from: '2026-10-11', to: '2026-10-11' }, 330);
    expect(p.fromUtc.toISOString()).toBe('2026-10-10T18:30:00.000Z');
    expect(p.toUtc.toISOString()).toBe('2026-10-11T18:30:00.000Z');
    const w = resolvePeriod({ from: '2026-10-11', to: '2026-10-11' }, -480);
    expect(w.fromUtc.toISOString()).toBe('2026-10-11T08:00:00.000Z');
  });
  it('handles month presets and rejects bad ranges', () => {
    expect(resolvePeriod({ preset: 'lastMonth' }, 0, now)).toMatchObject({ from: '2026-10-01', to: '2026-10-31', days: 31 });
    expect(resolvePeriod({ preset: 'mtd' }, 0, now)).toMatchObject({ from: '2026-11-01', to: '2026-11-04' });
    expect(() => resolvePeriod({ from: '2026-02-31', to: '2026-03-01' }, 0)).toThrow();
    expect(() => resolvePeriod({ from: '2026-03-02', to: '2026-03-01' }, 0)).toThrow();
    expect(() => resolvePeriod({ from: '2026-03-02' }, 0)).toThrow();
    expect(() => resolvePeriod({ from: '2025-01-01', to: '2026-12-31' }, 0)).toThrow();
  });
});

describe('CSV safety', () => {
  it('neutralises spreadsheet formulas in text but not numbers', () => {
    const csv = toCsv({ columns: [{ key: 'a', label: 'Name', type: 'text' }, { key: 'b', label: 'Amount', type: 'money' }], rows: [{ a: '=HYPERLINK("http://x")', b: -250 }, { a: 'Plain, with comma', b: 1050 }], totals: null, notes: [], mixedCurrency: false } as any).toString('utf8');
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain('"\'=HYPERLINK(""http://x"")",-2.5');
    expect(csv).toContain('"Plain, with comma",10.5');
  });
});

describe('reports', () => {
  let a: Awaited<ReturnType<typeof signup>>, b: Awaited<ReturnType<typeof signup>>;
  let manager: Record<string, string>, waiter: Record<string, string>;
  const get = (key: string, q = 'from=2026-10-10&to=2026-10-11', h = a.auth) => request(app).get(`/api/reports/${key}?${q}`).set(h);
  const row = (rep: any, k: string, v: string) => rep.rows.find((r: any) => r[k] === v);
  let o1: string, o2: string;

  beforeAll(async () => {
    a = await signup('a'); b = await signup('b');
    await request(app).put('/api/restaurant').set(a.auth).send({ published: true, orderTypes: ['TAKEAWAY', 'DINE_IN'], taxPercent: 0, utcOffsetMinutes: 330 });
    const mains = (await request(app).post('/api/categories').set(a.auth).send({ name: 'Mains' })).body.id;
    const sides = (await request(app).post('/api/categories').set(a.auth).send({ name: 'Sides' })).body.id;
    const burger = (await request(app).post('/api/products').set(a.auth).send({ categoryId: mains, name: 'Burger', priceCents: 10000 })).body.id;
    const fries = (await request(app).post('/api/products').set(a.auth).send({ categoryId: sides, name: 'Fries', priceCents: 5000 })).body.id;
    const place = async (name: string, phone: string, items: { productId: string; quantity: number }[]) => {
      const r = await request(app).post(`/api/public/${a.slug}/orders`).send({ type: 'TAKEAWAY', customerName: name, customerPhone: phone, items });
      expect(r.status).toBe(201);
      return (await prisma.order.findFirstOrThrow({ where: { restaurantId: a.restaurantId, customerName: name }, orderBy: { createdAt: 'desc' } })).id;
    };
    o1 = await place('Rita Repeat', '+919100000001', [{ productId: burger, quantity: 2 }]);        // 200.00
    o2 = await place('Rita Repeat', '+919100000001', [{ productId: fries, quantity: 1 }, { productId: burger, quantity: 1 }]); // 150.00
    const o3 = await place('Carl Cancelled', '+919100000002', [{ productId: burger, quantity: 1 }]);
    const o4 = await place('Fred First', '+919100000003', [{ productId: fries, quantity: 2 }]);      // 100.00
    const at = (id: string, iso: string, extra: object = {}) => prisma.order.update({ where: { id }, data: { createdAt: new Date(iso), ...extra } });
    await at(o1, '2026-10-10T18:40:00Z');                                  // 00:10 on 11 Oct in India, 18:40 on the 10th in UTC
    await at(o2, '2026-10-10T18:20:00Z');                                  // 23:50 on 10 Oct in India
    await at(o3, '2026-10-10T08:00:00Z', { status: 'CANCELLED' });
    await at(o4, '2026-10-11T07:00:00Z', { discountCents: 1000, couponCode: 'SAVE10', totalCents: 9000 });
    await prisma.order.update({ where: { id: o4 }, data: { paymentStatus: 'UNPAID' } });
    expect((await request(app).patch(`/api/orders/${o2}/payment`).set(a.auth).send({ paymentStatus: 'PAID' })).status).toBe(200);
    expect((await request(app).patch(`/api/orders/${o1}/payment`).set(a.auth).send({ paymentStatus: 'PAID' })).status).toBe(200);
    expect((await request(app).patch(`/api/orders/${o1}/payment`).set(a.auth).send({ paymentStatus: 'REFUNDED' })).status).toBe(200);

    for (const [role, store] of [['MANAGER', 'm'], ['WAITER', 'w']] as const) {
      const email = `rep-${store}-${uid}@example.com`;
      expect((await request(app).post('/api/staff').set(a.auth).send({ name: `Staff ${store}`, email, password: 'Password123!', role })).status).toBe(201);
      const l = await request(app).post('/api/auth/login').send({ email, password: 'Password123!' });
      (store === 'm' ? (manager = bearer(l.body.accessToken)) : (waiter = bearer(l.body.accessToken)));
    }
  });

  it('lists reports with availability', async () => {
    const r = await request(app).get('/api/reports').set(a.auth);
    expect(r.status).toBe(200);
    expect(r.body.reports.map((x: any) => x.key)).toEqual(expect.arrayContaining(['sales-daily', 'sales-monthly', 'categories', 'products', 'payments', 'refunds', 'outlets', 'peak-hours', 'reservations', 'inventory-usage', 'staff-performance', 'discounts', 'order-types', 'customer-acquisition', 'repeat-customers']));
    expect(r.body.reports).toHaveLength(15);
  });

  it('daily sales are exact and follow the restaurant clock', async () => {
    const rep = (await get('sales-daily')).body;
    expect(rep.timezone).toBe('UTC+05:30');
    expect(rep.rows.map((r: any) => [r.date, r.orders, r.total])).toEqual([['2026-10-10', 1, 15000], ['2026-10-11', 2, 29000]]); // cancelled order excluded; 00:10 IST belongs to the 11th
    expect(rep.totals).toMatchObject({ orders: 3, items: 6, gross: 45000, discounts: 1000, total: 44000, avg: 14667 });
    expect(rep.rows[1]).toMatchObject({ items: 4, gross: 30000, discounts: 1000 });
  });

  it('shows the same orders on different days for a different clock, and the totals still agree', async () => {
    await prisma.restaurant.update({ where: { id: a.restaurantId }, data: { utcOffsetMinutes: 0 } });
    try {
      const rep = (await get('sales-daily')).body;
      expect(rep.timezone).toBe('UTC+00:00');
      expect(rep.rows.map((r: any) => [r.date, r.orders, r.total])).toEqual([['2026-10-10', 2, 35000], ['2026-10-11', 1, 9000]]);
      expect(rep.totals.total).toBe(44000);
      const peak = (await get('peak-hours')).body;
      expect(row(peak, 'hour', '18:00–19:00').orders).toBe(2);
    } finally {
      await prisma.restaurant.update({ where: { id: a.restaurantId }, data: { utcOffsetMinutes: 330 } });
    }
  });

  it('monthly sales fill empty months and match the daily total', async () => {
    const rep = (await get('sales-monthly', 'from=2026-09-15&to=2026-11-02')).body;
    expect(rep.rows.map((r: any) => [r.month, r.orders, r.total])).toEqual([['2026-09', 0, 0], ['2026-10', 3, 44000], ['2026-11', 0, 0]]);
  });

  it('breaks sales down by category, item, type and hour', async () => {
    const cat = (await get('categories')).body;
    expect(cat.rows.map((r: any) => [r.category, r.qty, r.revenue])).toEqual([['Mains', 3, 30000], ['Sides', 3, 15000]]);
    expect(cat.rows[0].share).toBeCloseTo(66.7, 1);
    const prod = (await get('products')).body;
    expect(prod.rows.map((r: any) => [r.product, r.qty, r.revenue, r.avgPrice])).toEqual([['Burger', 3, 30000, 10000], ['Fries', 3, 15000, 5000]]);
    const types = (await get('order-types')).body;
    expect(row(types, 'type', 'Takeaway')).toMatchObject({ orders: 3, total: 44000, orderShare: 100 });
    expect(row(types, 'type', 'Delivery')).toMatchObject({ orders: 0, total: 0 });
    const peak = (await get('peak-hours')).body;
    expect(peak.rows).toHaveLength(24);
    expect(['23:00–00:00', '00:00–01:00', '12:00–13:00'].map((h) => row(peak, 'hour', h).orders)).toEqual([1, 1, 1]);
    expect(peak.totals.orders).toBe(3);
  });

  it('reports payments, discounts and refunds', async () => {
    const pay = (await get('payments')).body;
    expect(row(pay, 'method', 'Cash (at the restaurant or on delivery)')).toMatchObject({ orders: 3, total: 44000, collected: 35000, outstanding: 9000, refunded: 20000, net: 15000 });
    expect(row(pay, 'method', 'Online')).toMatchObject({ orders: 0, total: 0 });
    const disc = (await get('discounts')).body;
    expect(disc.rows).toHaveLength(1);
    expect(disc.rows[0]).toMatchObject({ code: 'SAVE10', orders: 1, discount: 1000, share: 100 });
    expect(disc.rows[0].pctOfSales).toBeCloseTo(10, 1);
    const ref = (await get('refunds', 'preset=today')).body;
    expect(ref.rows).toHaveLength(1);
    expect(ref.rows[0]).toMatchObject({ method: 'Cash (marked refunded)', amount: 20000, by: 'Owner' });
    expect((await get('refunds')).body.rows).toHaveLength(0); // the refund was made today, not in October
  });

  it('reports customers, reservations, inventory and staff', async () => {
    const rep = (await get('repeat-customers')).body;
    expect(rep.rows).toHaveLength(1);
    expect(rep.rows[0]).toMatchObject({ name: 'Rita Repeat', orders: 2, spent: 35000 });
    const acq = (await get('customer-acquisition', 'preset=today')).body;
    expect(acq.totals.fresh).toBeGreaterThanOrEqual(3);
    const res = (await get('reservations')).body;
    expect(res.totals.bookings).toBe(0);
    expect(res.rows).toHaveLength(2);
    expect((await get('inventory-usage')).status).toBe(200);
    expect((await get('staff-performance', 'preset=today')).status).toBe(200);
  });

  it('never mixes in another restaurant\'s data', async () => {
    const rep = (await get('sales-daily', 'from=2026-10-10&to=2026-10-11', b.auth)).body;
    expect(rep.totals.orders).toBe(0);
    expect((await get('products', 'from=2026-10-10&to=2026-10-11', b.auth)).body.rows).toEqual([]);
  });

  it('validates the period', async () => {
    expect((await get('sales-daily', 'from=2026-10-12&to=2026-10-11')).status).toBe(400);
    expect((await get('sales-daily', 'from=2026-02-30&to=2026-03-01')).status).toBe(400);
    expect((await get('sales-daily', 'from=2026-10-01')).status).toBe(400);
    expect((await get('sales-daily', 'from=2024-01-01&to=2026-01-01')).status).toBe(400);
    expect((await get('sales-daily', 'preset=forever')).status).toBe(400);
    expect((await get('nope')).status).toBe(404);
    expect((await get('sales-daily', "from=2026-10-01'; DROP TABLE \"Order\";--&to=2026-10-02")).status).toBe(400);
  });

  it('keeps reports to managers, the outlet comparison to owners, and advanced ones to the right plans', async () => {
    expect((await request(app).get('/api/reports')).status).toBe(401);
    expect((await get('sales-daily', undefined, waiter)).status).toBe(403);
    expect((await get('sales-daily', undefined, manager)).status).toBe(200);
    expect((await get('outlets', undefined, manager)).status).toBe(403);
    const out = await get('outlets');
    expect(out.status).toBe(200);
    expect(out.body.rows[0]).toMatchObject({ orders: 3, total: 44000 });
    expect(out.body.totals).toMatchObject({ orders: 3, total: 44000 });
    expect((await request(app).get('/api/orders').set(waiter)).status).toBe(200); // the reports router must not lock waiters out of other routes

    const growth = await prisma.plan.findFirstOrThrow({ where: { code: 'GROWTH' } });
    await prisma.subscription.update({ where: { tenantId: b.tenantId }, data: { planId: growth.id, status: 'ACTIVE' } });
    expect((await get('sales-daily', undefined, b.auth)).status).toBe(200);
    const blocked = await get('categories', undefined, b.auth);
    expect(blocked.status).toBe(402);
    expect((await request(app).get('/api/reports/categories/export?format=csv&preset=today').set(b.auth)).status).toBe(402);
    const list = (await request(app).get('/api/reports').set(b.auth)).body.reports;
    expect(list.find((r: any) => r.key === 'categories').available).toBe(false);
    expect(list.find((r: any) => r.key === 'sales-daily').available).toBe(true);
  });

  describe('exports', () => {
    const exp = (key: string, format: string, q = 'from=2026-10-10&to=2026-10-11', h = a.auth) => request(app).get(`/api/reports/${key}/export?format=${format}&${q}`).set(h).buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on('data', (d: Buffer) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });

    it('exports CSV that matches the screen', async () => {
      const r = await exp('sales-daily', 'csv');
      expect(r.status).toBe(200);
      expect(r.headers['content-type']).toContain('text/csv');
      expect(r.headers['content-disposition']).toBe('attachment; filename="sales-daily_2026-10-10_to_2026-10-11.csv"');
      const text = (r.body as Buffer).toString('utf8').replace(/^﻿/, '');
      const lines = text.trim().split('\r\n');
      expect(lines[0]).toBe('Date,Orders,Items,Item sales,Discounts,Tax,Service charge,Delivery fees,Tips,Order total,Average order');
      expect(lines[1]).toBe('2026-10-10,1,2,150,0,0,0,0,0,150,150');
      expect(lines[2]).toBe('2026-10-11,2,4,300,10,0,0,0,0,290,145');
      expect(lines[3]).toBe('Total,3,6,450,10,0,0,0,0,440,146.67');
    });

    it('exports an Excel workbook that a spreadsheet library can open', async () => {
      const r = await exp('sales-daily', 'xlsx');
      expect(r.status).toBe(200);
      expect(r.headers['content-type']).toContain('spreadsheetml.sheet');
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(r.body as Buffer);
      const ws = wb.worksheets[0];
      expect(ws.name).toBe('Daily sales');
      const cells: Record<string, unknown> = {};
      ws.eachRow((row) => { const v = row.values as unknown[]; if (v[1] === 'Date') cells.header = v.slice(1); if (v[1] === '2026-10-11') cells.day = v.slice(1); if (v[1] === 'Total') cells.total = v.slice(1); });
      expect(cells.header).toContain('Order total');
      expect(cells.day).toEqual(['2026-10-11', 2, 4, 300, 10, 0, 0, 0, 0, 290, 145]);
      expect((cells.total as number[])[9]).toBeCloseTo(440, 5);
      expect(ws.getCell(`D${ws.rowCount - 4}`).numFmt).toBeTruthy();
      expect(Object.keys(unzipSync(new Uint8Array(r.body as Buffer)))).toContain('xl/styles.xml');
    });

    it('exports a PDF', async () => {
      const r = await exp('sales-daily', 'pdf');
      expect(r.status).toBe(200);
      expect(r.headers['content-type']).toBe('application/pdf');
      const pdf = (r.body as Buffer).toString('latin1');
      expect(pdf.startsWith('%PDF-')).toBe(true);
      expect(pdf.trimEnd().endsWith('%%EOF')).toBe(true);
      const text = [...pdf.matchAll(/<([0-9a-f]{2,})>/g)].map((m) => Buffer.from(m[1], 'hex').toString('latin1')).join('');
      expect(text).toContain('Daily sales');
      expect(text).toContain('Order total');
      expect(text).toContain('440.00'); // the total row
      expect(text).toContain('2026-10-11');
    });

    it('paginates large PDFs and survives non-Latin names', async () => {
      const r = await exp('peak-hours', 'pdf', 'from=2026-10-01&to=2026-10-31');
      expect(r.status).toBe(200);
      expect((r.body as Buffer).length).toBeGreaterThan(1000);
    });

    it('rejects unknown formats, records exports in the audit log, and respects plan and role', async () => {
      expect((await exp('sales-daily', 'docx')).status).toBe(400);
      expect((await exp('sales-daily', 'csv', 'from=2026-10-10&to=2026-10-11', waiter)).status).toBe(403);
      expect((await request(app).get('/api/reports/sales-daily/export?format=csv&preset=today')).status).toBe(401);
      const logs = await prisma.auditLog.findMany({ where: { restaurantId: a.restaurantId, action: 'report.export' } });
      expect(logs.length).toBeGreaterThanOrEqual(3);
      expect(logs[0].detail).toMatchObject({ report: 'sales-daily' });
    });
  });
});
