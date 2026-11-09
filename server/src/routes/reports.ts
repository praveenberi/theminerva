import { Router } from 'express';
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { z } from 'zod';
import { attachAuth, requirePerm } from '../lib/auth.js';
import { badRequest, parse, wrap } from '../lib/http.js';
import { csvStringify } from '../lib/csv.js';
import { staffOutlet } from './orders.js';
import { REPORTS, ReportKey, compareOutlets, dashboard, resolveRange, runReport } from '../services/reports.js';
import { audit } from '../lib/audit.js';

export const reportRouter = Router();
const guard = [attachAuth, requirePerm('reports.view')];
const rangeQ = z.object({ range: z.enum(['today', 'yesterday', 'last7', 'last30', 'this_month', 'prev_month', 'custom']).default('today'), from: z.string().optional(), to: z.string().optional() });

reportRouter.get('/dashboard', ...guard, wrap(async (req, res) => {
  const q = parse(rangeQ, req.query);
  const r = await resolveRange(q.range, q.from, q.to);
  const own = await staffOutlet(req.staff!.id);
  const oid = own ?? (typeof req.query.outletId === 'string' && req.query.outletId ? req.query.outletId : null);
  res.json(await dashboard(r.from, r.to, r.tz, oid));
}));

reportRouter.get('/outlets/compare', ...guard, wrap(async (req, res) => {
  if (await staffOutlet(req.staff!.id)) throw badRequest('Branch comparison is for head-office accounts');
  const q = parse(rangeQ, req.query);
  const r = await resolveRange(q.range === 'today' && !req.query.range ? 'last30' : q.range, q.from, q.to);
  res.json({ range: { from: r.fromLocal, to: r.toLocal }, branches: await compareOutlets(r.from, r.to) });
}));

reportRouter.get('/', ...guard, wrap(async (_req, res) => {
  res.json(Object.entries(REPORTS).map(([key, title]) => ({ key, title })));
}));

reportRouter.get('/:key', ...guard, wrap(async (req, res) => {
  const key = req.params.key as ReportKey;
  if (!(key in REPORTS)) throw badRequest('Unknown report');
  const q = parse(rangeQ.extend({ format: z.enum(['json', 'csv', 'xlsx', 'pdf']).default('json') }), req.query);
  const r = await resolveRange(q.range === 'today' && !req.query.range ? 'last30' : q.range, q.from, q.to);
  const data = await runReport(key, r.from, r.to, r.tz);
  const meta = { ...data, range: { from: r.fromLocal, to: r.toLocal, tz: r.tz } };
  if (q.format === 'json') return res.json(meta);
  await audit(req, 'report.export', 'Report', key, { format: q.format });
  const file = `${key}-${r.fromLocal}_${r.toLocal}`;
  if (q.format === 'csv') return res.type('text/csv').attachment(`${file}.csv`).send(csvStringify([data.columns, ...data.rows]));
  if (q.format === 'xlsx') {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(data.title.slice(0, 30));
    ws.addRow(data.columns).font = { bold: true };
    // strings starting with = + - @ are written as text (never as formulas)
    for (const row of data.rows) ws.addRow(row.map((c) => (typeof c === 'string' && /^[=+\-@]/.test(c) ? { richText: [{ text: c }] } : c)));
    ws.columns.forEach((c) => (c.width = 18));
    res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').attachment(`${file}.xlsx`);
    await wb.xlsx.write(res);
    return res.end();
  }
  res.type('application/pdf').attachment(`${file}.pdf`);
  const doc = new PDFDocument({ size: 'A4', margin: 40, layout: data.columns.length > 4 ? 'landscape' : 'portrait' });
  doc.pipe(res);
  doc.fontSize(18).text(`The Minerva — ${data.title}`).fontSize(9).fillColor('#555').text(`${r.fromLocal} to ${r.toLocal} (${r.tz})`).moveDown().fillColor('#000');
  const w = (doc.page.width - 80) / data.columns.length;
  const line = (cells: Array<string | number>, bold = false) => {
    if (doc.y > doc.page.height - 60) doc.addPage();
    const y = doc.y;
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9);
    cells.forEach((c, i) => doc.text(String(c), 40 + i * w, y, { width: w - 4, lineBreak: false, ellipsis: true }));
    doc.y = y + 15;
  };
  line(data.columns, true);
  for (const row of data.rows) line(row);
  if (!data.rows.length) doc.text('No data for this period.');
  doc.end();
}));
