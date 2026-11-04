import PDFDocument from 'pdfkit';
import { strToU8, zipSync } from 'fflate';
import { csvRow } from './csv';
import type { BuiltReport, Cell, Col } from './reports';

export type ExportFormat = 'csv' | 'xlsx' | 'pdf';
export const EXPORT_TYPES: Record<ExportFormat, string> = {
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
};

const major = (minor: number) => minor / 100; // every supported currency here has two decimals
const groupFmt = (n: number, dp: number) => n.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });

/** Text as shown to a person (PDF and the web table). */
export function display(col: Col, v: Cell): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  switch (col.type) {
    case 'money': return groupFmt(major(v), 2);
    case 'percent': return `${groupFmt(v, 1)}%`;
    case 'minutes': return `${groupFmt(v, 1)} min`;
    case 'decimal': return groupFmt(v, Number.isInteger(v) ? 0 : 3).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
    default: return groupFmt(v, 0);
  }
}

const metaLines = (r: BuiltReport) => [
  r.title, `${r.restaurant} · ${r.period.label} · ${r.timezone}`,
  r.mixedCurrency ? 'Money in each outlet\'s own currency' : `Amounts in ${r.currency}`,
];

// ---------------- CSV ----------------
/** Plain table, so it imports cleanly anywhere. A UTF-8 byte-order mark makes Excel read accents and ₹ correctly. */
export function toCsv(r: BuiltReport): Buffer {
  const val = (c: Col, v: Cell) => (v == null ? '' : typeof v === 'number' ? (c.type === 'money' ? major(v) : v) : v);
  const lines = [csvRow(r.columns.map((c) => c.label))];
  for (const row of r.rows) lines.push(csvRow(r.columns.map((c) => val(c, row[c.key] ?? null))));
  if (r.totals) lines.push(csvRow(r.columns.map((c) => val(c, r.totals![c.key] ?? null))));
  return Buffer.concat([Buffer.from('﻿', 'utf8'), Buffer.from(lines.join('\r\n') + '\r\n', 'utf8')]);
}

// ---------------- XLSX (hand-written OOXML, zipped with fflate) ----------------
const xml = (s: string) => s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const colName = (i: number) => { let s = ''; for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };

// cellXfs index = type base * 2 + bold(0/1); 0..: text,int,money,percent,decimal,minutes; then 12 title, 13 header, 14 note
const NUMFMTS = [[164, '#,##0.00'], [165, '0.0"%"'], [166, '#,##0.###'], [167, '0.0" min"']] as const;
const TYPE_FMT: Record<string, number> = { text: 0, date: 0, datetime: 0, int: 3, money: 164, percent: 165, decimal: 166, minutes: 167 };
const TYPE_BASE = ['text', 'int', 'money', 'percent', 'decimal', 'minutes'] as const;
const baseOf = (t: string) => (t === 'date' || t === 'datetime' ? 0 : TYPE_BASE.indexOf(t as any));

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="${NUMFMTS.length}">${NUMFMTS.map(([id, code]) => `<numFmt numFmtId="${id}" formatCode="${xml(code)}"/>`).join('')}</numFmts>
<fonts count="4"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="14"/><name val="Calibri"/></font><font><i/><sz val="10"/><color rgb="FF555555"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE8EEF4"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top style="thin"><color rgb="FF999999"/></top><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="15">${TYPE_BASE.map((t) => [0, 1].map((b) => `<xf numFmtId="${TYPE_FMT[t]}" fontId="${b}" fillId="0" borderId="${b}" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1"${t === 'text' ? '' : '><alignment horizontal="right"/></xf>'}${t === 'text' ? '/>' : ''}`).join('')).join('')}<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment wrapText="1" vertical="center"/></xf><xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

const S_TITLE = 12, S_HEAD = 13, S_NOTE = 14;

export function toXlsx(r: BuiltReport): Buffer {
  const rowsXml: string[] = [];
  let n = 0;
  const str = (ref: string, s: string, style: number) => `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xml(s)}</t></is></c>`; // inline strings are never evaluated as formulas
  const push = (cells: string[], ht?: number) => { n++; rowsXml.push(`<row r="${n}"${ht ? ` ht="${ht}" customHeight="1"` : ''}>${cells.map((c) => c.replace(/\{R\}/g, String(n))).join('')}</row>`); };

  const [title, sub, cur] = metaLines(r);
  push([str('A{R}', title, S_TITLE)], 22);
  push([str('A{R}', sub, S_NOTE)]);
  push([str('A{R}', cur + ` · generated ${r.generatedAt.slice(0, 16).replace('T', ' ')} UTC`, S_NOTE)]);
  n++; rowsXml.push(`<row r="${n}"/>`);
  const headerRow = n + 1;
  push(r.columns.map((c, i) => str(`${colName(i)}{R}`, c.label, S_HEAD)), 32);

  const dataRow = (src: Record<string, Cell>, bold: 0 | 1) => push(r.columns.map((c, i) => {
    const v = src[c.key] ?? null, ref = `${colName(i)}{R}`;
    if (v == null) return `<c r="${ref}" s="${baseOf(c.type) * 2 + bold}"/>`;
    if (typeof v === 'string') return str(ref, v, baseOf(c.type) * 2 + bold);
    return `<c r="${ref}" s="${baseOf(c.type) * 2 + bold}"><v>${c.type === 'money' ? major(v) : v}</v></c>`;
  }));
  for (const row of r.rows) dataRow(row, 0);
  if (r.totals) dataRow(r.totals, 1);
  if (r.notes.length) { n++; rowsXml.push(`<row r="${n}"/>`); for (const note of r.notes) push([str('A{R}', note, S_NOTE)]); }

  const widths = r.columns.map((c, i) => {
    let w = Math.min(14, c.label.length * 0.55 + 2);
    for (const row of [...r.rows.slice(0, 300), ...(r.totals ? [r.totals] : [])]) w = Math.max(w, display(c, row[c.key] ?? null).length + 2);
    return Math.min(46, Math.max(10, w)) + (i === 0 ? 2 : 0);
  });
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0" showGridLines="1"><pane ySplit="${headerRow}" topLeftCell="A${headerRow + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/><cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w.toFixed(1)}" customWidth="1"/>`).join('')}</cols><sheetData>${rowsXml.join('')}</sheetData></worksheet>`;

  const sheetName = xml(r.title.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31));
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`),
    '_rels/.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    'xl/workbook.xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${sheetName}" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    'xl/_rels/workbook.xml.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`),
    'xl/styles.xml': strToU8(STYLES),
    'xl/worksheets/sheet1.xml': strToU8(sheet),
  };
  return Buffer.from(zipSync(files, { level: 6 }));
}

// ---------------- PDF ----------------
// The built-in PDF fonts only cover Western European text; anything else would print as garbage, so it prints as "?".
const latin = (s: string) => s.replace(/−/g, '-').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[^\u0009\u000A -~¡-ÿ–—•€]/g, '?');

export function toPdf(r: BuiltReport): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 36, bufferPages: true, compress: false, info: { Title: r.title, Author: r.restaurant, Creator: 'Tablely' } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const left = 36, width = doc.page.width - 72, bottom = doc.page.height - 48;
    const weights = r.columns.map((c) => {
      let w = Math.min(14, c.label.length * 0.7);
      for (const row of [...r.rows.slice(0, 200), ...(r.totals ? [r.totals] : [])]) w = Math.max(w, Math.min(34, display(c, row[c.key] ?? null).length));
      return Math.max(6, w);
    });
    const sum = weights.reduce((a, b) => a + b, 0);
    const colW = weights.map((w) => (w / sum) * width);
    const fs = r.columns.length > 9 ? 7 : 8;
    const pad = 3;
    const isText = (c: Col) => c.type === 'text' || c.type === 'date' || c.type === 'datetime';

    const rowHeight = (cells: string[], bold: boolean) => {
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(fs);
      return Math.max(...cells.map((t, i) => doc.heightOfString(t, { width: colW[i] - pad * 2 }))) + pad * 2;
    };
    const drawRow = (cells: string[], y: number, h: number, bold: boolean, fill?: string) => {
      if (fill) doc.rect(left, y, width, h).fill(fill);
      doc.fillColor('#111').font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(fs);
      let x = left;
      cells.forEach((t, i) => { doc.text(t, x + pad, y + pad, { width: colW[i] - pad * 2, align: isText(r.columns[i]) ? 'left' : 'right' }); x += colW[i]; });
      doc.moveTo(left, y + h).lineTo(left + width, y + h).lineWidth(0.3).strokeColor('#ccc').stroke();
    };
    const header = () => {
      const cells = r.columns.map((c) => latin(c.label));
      const h = rowHeight(cells, true);
      const y = doc.y;
      drawRow(cells, y, h, true, '#e8eef4');
      doc.y = y + h;
    };
    const ensure = (h: number) => { if (doc.y + h > bottom) { doc.addPage(); header(); } };

    doc.font('Helvetica-Bold').fontSize(16).fillColor('#111').text(latin(r.title), left, 36);
    const [, sub, cur] = metaLines(r);
    doc.font('Helvetica').fontSize(9).fillColor('#555').text(latin(sub)).text(latin(cur + ` · generated ${r.generatedAt.slice(0, 16).replace('T', ' ')} UTC`));
    doc.moveDown(0.8);
    header();

    const lines = [...r.rows.map((row) => ({ row, bold: false })), ...(r.totals ? [{ row: r.totals, bold: true }] : [])];
    if (!r.rows.length) { doc.font('Helvetica-Oblique').fontSize(10).fillColor('#555').text('No data in this period.', left, doc.y + 6); }
    for (const { row, bold } of lines) {
      const cells = r.columns.map((c) => latin(display(c, row[c.key] ?? null)));
      const h = rowHeight(cells, bold);
      ensure(h);
      const y = doc.y;
      drawRow(cells, y, h, bold, bold ? '#f3f5f7' : undefined);
      doc.y = y + h;
    }
    if (r.notes.length) {
      doc.moveDown(1).font('Helvetica').fontSize(8).fillColor('#555');
      for (const note of r.notes) { if (doc.y + 14 > bottom) doc.addPage(); doc.font('Helvetica').fontSize(8).fillColor('#555').text(latin('• ' + note), left, doc.y, { width }); }
    }
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      doc.page.margins.bottom = 0; // otherwise writing the footer inside the bottom margin makes pdfkit start a new, empty page
      doc.font('Helvetica').fontSize(8).fillColor('#777');
      doc.text(`Page ${i + 1} of ${range.count}`, left, doc.page.height - 30, { width, align: 'right', lineBreak: false });
    }
    doc.end();
  });
}

export async function exportReport(r: BuiltReport, format: ExportFormat): Promise<Buffer> {
  return format === 'csv' ? toCsv(r) : format === 'xlsx' ? toXlsx(r) : toPdf(r);
}

export const exportFilename = (r: BuiltReport, format: ExportFormat) =>
  `${r.key}_${r.period.from}${r.period.from === r.period.to ? '' : `_to_${r.period.to}`}.${format}`;
