import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { Button, Card, EmptyState, QueryBoundary, Select, useToast } from '@/components/ui';
import { RangePicker } from '@/pages/admin/Dashboard';
import { api, download, errorMessage } from '@/lib/api';
import { useSeo } from '@/lib/hooks';
import { useOutletFilter } from '@/lib/outlet';
import { money } from '@/lib/format';

export default function Reports() {
  useSeo('Reports');
  const toast = useToast();
  const list = useQuery({ queryKey: ['report-list'], queryFn: () => api('/api/reports') });
  const [key, setKey] = useState('daily-sales');
  const [r, setR] = useState<{ range: string; from?: string; to?: string }>({ range: 'last30' });
  const ready = r.range !== 'custom' || (r.from && r.to && r.to >= r.from);
  const q = useQuery({ queryKey: ['report', key, r], enabled: !!ready, queryFn: () => api(`/api/reports/${key}`, { query: r }) });
  const branch = useOutletFilter();
  const cmp = useQuery({ queryKey: ['compare', r], enabled: !!ready && branch.all.length > 1, retry: false, queryFn: () => api('/api/reports/outlets/compare', { query: r }) });
  const exp = (format: string) => download(`/api/reports/${key}`, `${key}.${format}`, { ...r, format }).catch((e) => toast('error', errorMessage(e)));
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Select aria-label="Report" className="w-64" value={key} onChange={(e) => setKey(e.target.value)}>{(list.data ?? []).map((x: any) => <option key={x.key} value={x.key}>{x.title}</option>)}</Select>
        <RangePicker value={r} onChange={setR} />
        <div className="ml-auto flex gap-2">{['csv', 'xlsx', 'pdf'].map((f) => <Button key={f} variant="outline" size="sm" onClick={() => exp(f)}><Download className="h-4 w-4" /> {f.toUpperCase()}</Button>)}</div>
      </div>
      {branch.all.length > 1 && cmp.data && (
        <Card className="overflow-x-auto"><div className="border-b border-border p-3"><h2 className="text-xl">Branch comparison</h2><p className="text-xs text-muted">Completed orders, {cmp.data.range.from} to {cmp.data.range.to}</p></div>
          <table className="w-full text-sm"><thead className="border-b border-border text-left text-xs uppercase text-muted"><tr><th className="p-3">Branch</th><th>Orders</th><th>Revenue</th><th>Avg order</th><th>Deliveries</th></tr></thead><tbody>{cmp.data.branches.map((b: any) => <tr key={b.branch} className="border-b border-border/60 last:border-0"><td className="p-3 font-medium">{b.branch}</td><td>{b.orders}</td><td>{money(b.revenue)}</td><td>{money(b.avg)}</td><td>{b.deliveries}</td></tr>)}</tbody></table></Card>)}
      <QueryBoundary q={q}>
        {(d) => (
          <Card className="overflow-x-auto">
            <div className="border-b border-border p-3"><h2 className="text-xl">{d.title}</h2><p className="text-xs text-muted">{d.range.from} to {d.range.to} · times in {d.range.tz}</p></div>
            {d.rows.length === 0 ? <div className="p-4"><EmptyState title="No data for this period" /></div> : (
              <table className="w-full text-sm"><thead className="border-b border-border text-left text-xs uppercase text-muted"><tr>{d.columns.map((c: string) => <th key={c} className="p-3">{c}</th>)}</tr></thead>
                <tbody>{d.rows.map((row: any[], i: number) => <tr key={i} className="border-b border-border/60 last:border-0">{row.map((c, j) => <td key={j} className="p-3">{c}</td>)}</tr>)}</tbody></table>)}
          </Card>)}
      </QueryBoundary>
    </div>
  );
}
