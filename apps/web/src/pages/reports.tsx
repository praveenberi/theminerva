import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Download, FileSpreadsheet, FileText, Lock } from 'lucide-react';
import { api, download, errMsg, useAuth } from '../lib';
import { Empty, Page, Skeleton, useToast } from '../ui';

interface Col { key: string; label: string; type: 'text' | 'int' | 'money' | 'percent' | 'decimal' | 'minutes' | 'date' | 'datetime' }
interface Report {
  key: string; title: string; description: string; restaurant: string; currency: string; timezone: string; generatedAt: string; mixedCurrency: boolean;
  period: { from: string; to: string; label: string; days: number };
  columns: Col[]; rows: Record<string, string | number | null>[]; totals: Record<string, string | number | null> | null; notes: string[];
  chart: { kind: 'bar' | 'line'; x: string; y: string } | null;
}
interface CatalogItem { key: string; title: string; description: string; group: string; tier: 'basic' | 'advanced'; available: boolean }

const PRESETS: [string, string][] = [['today', 'Today'], ['yesterday', 'Yesterday'], ['7d', 'Last 7 days'], ['30d', 'Last 30 days'], ['mtd', 'This month'], ['lastMonth', 'Last month']];
const GROUPS = ['Sales', 'Finance', 'Customers', 'Operations'];
const grouped = (n: number, dp: number) => n.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });

function cell(c: Col, v: string | number | null): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  switch (c.type) {
    case 'money': return grouped(v / 100, 2);
    case 'percent': return `${grouped(v, 1)}%`;
    case 'minutes': return `${grouped(v, 1)} min`;
    case 'decimal': return grouped(v, Number.isInteger(v) ? 0 : 3).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
    default: return grouped(v, 0);
  }
}

export function ReportsPage() {
  const { me } = useAuth();
  const toast = useToast();
  const [key, setKey] = useState('sales-daily');
  const [preset, setPreset] = useState('7d');
  const [custom, setCustom] = useState({ from: '', to: '' });
  const [useCustom, setUseCustom] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const catalog = useQuery({ queryKey: ['reports'], queryFn: () => api<{ currency: string; reports: CatalogItem[] }>('/reports') });
  const customReady = /^\d{4}-\d{2}-\d{2}$/.test(custom.from) && /^\d{4}-\d{2}-\d{2}$/.test(custom.to);
  const qs = useCustom ? `from=${custom.from}&to=${custom.to}` : `preset=${preset}`;
  const current = catalog.data?.reports.find((r) => r.key === key);
  const report = useQuery({
    queryKey: ['report', key, qs], enabled: !!current?.available && (!useCustom || customReady), retry: false,
    queryFn: () => api<Report>(`/reports/${key}?${qs}`),
  });

  async function exportAs(format: 'csv' | 'xlsx' | 'pdf') {
    setBusy(format);
    try { toast(`Downloaded ${await download(`/reports/${key}/export?format=${format}&${qs}`)}`); } catch (e) { toast(errMsg(e)); } finally { setBusy(null); }
  }

  const r = report.data;
  const chartData = r?.chart ? r.rows.map((row) => { const yc = r.columns.find((c) => c.key === r.chart!.y)!; return { x: String(row[r.chart!.x] ?? ''), y: Number(row[r.chart!.y] ?? 0) / (yc.type === 'money' ? 100 : 1) }; }) : [];
  const yLabel = r?.columns.find((c) => c.key === r.chart?.y)?.label ?? '';

  return (
    <Page>
      <h1 className="mb-1 text-2xl font-bold">Reports</h1>
      <p className="mb-4 text-sm text-stone-600">Figures come straight from your orders, in your restaurant’s own time zone. Cancelled orders and online orders awaiting payment are never counted as sales.</p>
      <div className="grid gap-4 lg:grid-cols-[240px_1fr]">
        <nav aria-label="Reports" className="card h-fit p-2">
          {!catalog.data ? <Skeleton className="h-64" /> : GROUPS.map((g) => {
            const items = catalog.data.reports.filter((x) => x.group === g);
            return items.length ? (
              <div key={g} className="mb-2">
                <p className="px-2 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-stone-500">{g}</p>
                {items.map((x) => (
                  <button key={x.key} onClick={() => setKey(x.key)} aria-current={x.key === key ? 'page' : undefined}
                    className={`flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left text-sm ${x.key === key ? 'bg-stone-900 text-white dark:bg-stone-100 dark:text-stone-900' : 'hover:bg-stone-100 dark:hover:bg-stone-800'}`}>
                    <span>{x.title}</span>{!x.available && <Lock size={13} aria-label="Needs a higher plan" />}
                  </button>))}
              </div>) : null;
          })}
        </nav>

        <section className="min-w-0">
          <div className="card mb-4">
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-48 flex-1"><h2 className="text-lg font-bold">{current?.title ?? 'Report'}</h2><p className="text-sm text-stone-600">{current?.description}</p></div>
              <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Period">
                {PRESETS.map(([k, label]) => (
                  <button key={k} className={!useCustom && preset === k ? 'btn-primary !px-3 !py-1.5 text-sm' : 'btn-ghost !px-3 !py-1.5 text-sm'} onClick={() => { setUseCustom(false); setPreset(k); }}>{label}</button>))}
              </div>
            </div>
            <div className="mt-3 flex flex-wrap items-end gap-2 text-sm">
              <label>From<input type="date" className="input ml-2 !w-auto" value={custom.from} onChange={(e) => { setCustom({ ...custom, from: e.target.value }); setUseCustom(true); }} /></label>
              <label>To<input type="date" className="input ml-2 !w-auto" value={custom.to} onChange={(e) => { setCustom({ ...custom, to: e.target.value }); setUseCustom(true); }} /></label>
              <div className="ml-auto flex gap-2">
                {([['csv', 'CSV', Download], ['xlsx', 'Excel', FileSpreadsheet], ['pdf', 'PDF', FileText]] as const).map(([f, label, Icon]) => (
                  <button key={f} className="btn-ghost !px-3 !py-1.5" disabled={!r || busy !== null} onClick={() => exportAs(f)}><Icon size={15} />{busy === f ? 'Preparing…' : label}</button>))}
              </div>
            </div>
            {r && <p className="mt-3 text-xs text-stone-500">{r.restaurant} · {r.period.label} ({r.period.days} day{r.period.days === 1 ? '' : 's'}) · clock {r.timezone} · {r.mixedCurrency ? 'each outlet’s own currency' : `amounts in ${r.currency}`}</p>}
          </div>

          {current && !current.available ? (
            <div className="card text-center">
              <Lock className="mx-auto mb-2 text-stone-400" />
              <h2 className="font-bold">{current.title} is part of Advanced reports</h2>
              <p className="mt-1 text-sm text-stone-600">{me!.role === 'OWNER' ? 'Upgrade your plan to unlock this report and every export.' : 'Ask the restaurant owner to upgrade the plan.'}</p>
              {me!.role === 'OWNER' && <Link className="btn-primary mt-4" to="/app/billing">See plans</Link>}
            </div>
          ) : useCustom && !customReady ? <Empty title="Pick both dates" hint="Choose a start and an end date, or use one of the shortcuts above." />
            : report.isError ? <div role="alert" className="card border-red-300 text-sm text-red-700">{errMsg(report.error)}</div>
            : !r ? <Skeleton className="h-72" />
            : (
              <>
                {r.chart && chartData.length > 0 && chartData.some((d) => d.y) && (
                  <div className="card mb-4" role="img" aria-label={`${r.title} chart of ${yLabel}`}>
                    <p className="mb-2 text-xs font-semibold uppercase text-stone-500">{yLabel}</p>
                    <ResponsiveContainer width="100%" height={240}>
                      {r.chart.kind === 'line' ? (
                        <LineChart data={chartData}><CartesianGrid strokeDasharray="3 3" vertical={false} /><XAxis dataKey="x" fontSize={11} minTickGap={24} /><YAxis fontSize={11} width={56} /><Tooltip formatter={(v: number) => grouped(v, 2)} /><Line type="monotone" dataKey="y" stroke="#e11d48" strokeWidth={2} dot={chartData.length < 40} /></LineChart>
                      ) : (
                        <BarChart data={chartData}><CartesianGrid strokeDasharray="3 3" vertical={false} /><XAxis dataKey="x" fontSize={11} interval="preserveStartEnd" minTickGap={12} /><YAxis fontSize={11} width={56} /><Tooltip formatter={(v: number) => grouped(v, 2)} /><Bar dataKey="y" fill="#e11d48" radius={[4, 4, 0, 0]} /></BarChart>
                      )}
                    </ResponsiveContainer>
                  </div>)}
                {r.rows.length === 0 ? <Empty title="Nothing to report for this period" hint="Try a longer period." /> : (
                  <div className="card overflow-x-auto p-0">
                    <table className="w-full text-sm">
                      <thead className="bg-stone-50 text-xs uppercase text-stone-500 dark:bg-stone-800"><tr>{r.columns.map((c) => <th key={c.key} scope="col" className={`px-3 py-2.5 ${['text', 'date', 'datetime'].includes(c.type) ? 'text-left' : 'text-right'}`}>{c.label}</th>)}</tr></thead>
                      <tbody>
                        {r.rows.map((row, i) => <tr key={i} className="border-t border-stone-100 dark:border-stone-800">{r.columns.map((c) => <td key={c.key} className={`px-3 py-2 ${['text', 'date', 'datetime'].includes(c.type) ? '' : 'text-right tabular-nums'}`}>{cell(c, row[c.key] ?? null)}</td>)}</tr>)}
                        {r.totals && <tr className="border-t-2 border-stone-300 bg-stone-50 font-bold dark:border-stone-600 dark:bg-stone-800">{r.columns.map((c) => <td key={c.key} className={`px-3 py-2 ${['text', 'date', 'datetime'].includes(c.type) ? '' : 'text-right tabular-nums'}`}>{cell(c, r.totals![c.key] ?? null)}</td>)}</tr>}
                      </tbody>
                    </table>
                  </div>)}
                {r.notes.length > 0 && <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-stone-500">{r.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
              </>)}
        </section>
      </div>
    </Page>
  );
}
