import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { motion } from 'motion/react';
import { AlertTriangle } from 'lucide-react';
import { Card, EmptyState, Input, QueryBoundary, Select, Skeleton } from '@/components/ui';
import { api } from '@/lib/api';
import { money, statusLabel, dateTime } from '@/lib/format';
import { useSeo } from '@/lib/hooks';
import { useOutletFilter } from '@/lib/outlet';

export const RANGES = [['today', 'Today'], ['yesterday', 'Yesterday'], ['last7', 'Last 7 days'], ['last30', 'Last 30 days'], ['this_month', 'This month'], ['prev_month', 'Previous month'], ['custom', 'Custom range']] as const;

export function RangePicker({ value, onChange }: { value: { range: string; from?: string; to?: string }; onChange: (v: { range: string; from?: string; to?: string }) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select aria-label="Date range" className="w-44" value={value.range} onChange={(e) => onChange({ ...value, range: e.target.value })}>{RANGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
      {value.range === 'custom' && (<>
        <Input aria-label="From" type="date" className="w-40" value={value.from ?? ''} onChange={(e) => onChange({ ...value, from: e.target.value })} />
        <Input aria-label="To" type="date" className="w-40" value={value.to ?? ''} onChange={(e) => onChange({ ...value, to: e.target.value })} />
      </>)}
    </div>
  );
}

const Kpi = ({ label, value, sub, i }: { label: string; value: string | number; sub?: string; i: number }) => (
  <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.04 }}>
    <Card className="p-4"><p className="text-xs uppercase tracking-wide text-muted">{label}</p><p className="mt-1 font-display text-3xl">{value}</p>{sub && <p className="text-xs text-muted">{sub}</p>}</Card>
  </motion.div>
);

export default function Dashboard() {
  useSeo('Dashboard');
  const [r, setR] = useState<{ range: string; from?: string; to?: string }>({ range: 'today' });
  const ready = r.range !== 'custom' || (r.from && r.to && r.to >= r.from);
  const { outletId } = useOutletFilter();
  const q = useQuery({ queryKey: ['dashboard', r, outletId], enabled: !!ready, queryFn: () => api('/api/reports/dashboard', { query: { ...r, outletId } }), refetchInterval: 60_000 });
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-2xl">Overview</h2><RangePicker value={r} onChange={setR} /></div>
      {!ready && <p className="text-sm text-muted">Choose a start and end date.</p>}
      <QueryBoundary q={q} skeleton={<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">{Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="h-24" />)}</div>}>
        {(d) => { const k = d.kpis; return (
          <>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Kpi i={0} label="Revenue" value={money(k.revenue)} sub={k.refunds ? `Net ${money(k.netRevenue)} after refunds` : 'Completed orders'} />
              <Kpi i={1} label="Total orders" value={k.totalOrders} />
              <Kpi i={2} label="Pending" value={k.pendingOrders} sub="In progress now" />
              <Kpi i={3} label="Completed" value={k.completedOrders} />
              <Kpi i={4} label="Cancelled / rejected" value={k.cancelledOrders} />
              <Kpi i={5} label="Avg order value" value={money(k.averageOrderValue)} />
              <Kpi i={6} label="Reservations" value={k.reservations} />
              <Kpi i={7} label="Active customers" value={k.activeCustomers} sub="Signed-in or recognised" />
            </div>
            <div className="grid gap-4 lg:grid-cols-2">
              <Card className="p-4"><h3 className="mb-3 text-lg">Revenue trend</h3>
                {d.revenueTrend.length === 0 ? <EmptyState title="No sales in this period" /> : (
                  <div className="h-64" role="img" aria-label="Revenue per day chart"><ResponsiveContainer><AreaChart data={d.revenueTrend}><CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" /><XAxis dataKey="day" tick={{ fontSize: 11 }} stroke="hsl(var(--muted))" /><YAxis tick={{ fontSize: 11 }} stroke="hsl(var(--muted))" width={50} /><Tooltip formatter={(v: any) => money(v)} contentStyle={{ borderRadius: 12, border: '1px solid hsl(var(--border))', background: 'hsl(var(--surface))' }} /><Area type="monotone" dataKey="revenue" stroke="hsl(var(--accent))" fill="hsl(var(--accent) / .25)" strokeWidth={2} /></AreaChart></ResponsiveContainer></div>)}</Card>
              <Card className="p-4"><h3 className="mb-3 text-lg">Order trend</h3>
                {d.revenueTrend.length === 0 ? <EmptyState title="No orders in this period" /> : (
                  <div className="h-64" role="img" aria-label="Orders per day chart"><ResponsiveContainer><BarChart data={d.revenueTrend}><CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" /><XAxis dataKey="day" tick={{ fontSize: 11 }} stroke="hsl(var(--muted))" /><YAxis allowDecimals={false} tick={{ fontSize: 11 }} stroke="hsl(var(--muted))" width={30} /><Tooltip contentStyle={{ borderRadius: 12, border: '1px solid hsl(var(--border))', background: 'hsl(var(--surface))' }} /><Bar dataKey="orders" fill="hsl(var(--brand))" radius={[6, 6, 0, 0]} /></BarChart></ResponsiveContainer></div>)}</Card>
            </div>
            <div className="grid gap-4 lg:grid-cols-3">
              <Card className="p-4"><h3 className="mb-2 text-lg">Best-selling dishes</h3>{d.bestSellers.length === 0 ? <p className="text-sm text-muted">No completed orders yet.</p> : <ol className="space-y-1.5 text-sm">{d.bestSellers.map((b: any, i: number) => <li key={b.name} className="flex justify-between"><span>{i + 1}. {b.name}</span><span className="text-muted">{b.qty} · {money(b.revenue)}</span></li>)}</ol>}</Card>
              <Card className="p-4"><h3 className="mb-2 text-lg">Popular categories</h3>{d.popularCategories.length === 0 ? <p className="text-sm text-muted">No data yet.</p> : <ul className="space-y-1.5 text-sm">{d.popularCategories.map((b: any) => <li key={b.name} className="flex justify-between"><span>{b.name}</span><span className="text-muted">{money(b.revenue)}</span></li>)}</ul>}</Card>
              <Card className="p-4"><h3 className="mb-2 flex items-center gap-2 text-lg">Low stock {d.lowStock.length > 0 && <AlertTriangle className="h-4 w-4 text-warn" />}</h3>{d.lowStock.length === 0 ? <p className="text-sm text-muted">All ingredients above reorder level.</p> : <ul className="space-y-1.5 text-sm">{d.lowStock.map((l: any) => <li key={l.id} className="flex justify-between"><span>{l.name}</span><span className="text-warn">{l.stock} {l.unit}</span></li>)}</ul>}<Link to="/admin/inventory" className="mt-2 inline-block text-sm underline">Open inventory</Link></Card>
              <Card className="p-4"><h3 className="mb-2 text-lg">Payment summary</h3>{d.payments.length === 0 ? <p className="text-sm text-muted">No payments in this period.</p> : <ul className="space-y-1.5 text-sm">{d.payments.map((p: any, i: number) => <li key={i} className="flex justify-between"><span>{statusLabel(p.method)} · {statusLabel(p.status)} ({p.n})</span><span>{money(p.amount)}</span></li>)}</ul>}</Card>
              <Card className="p-4"><h3 className="mb-2 text-lg">Staff activity</h3>{d.staffPerformance.length === 0 ? <p className="text-sm text-muted">No order handling yet.</p> : <ul className="space-y-1.5 text-sm">{d.staffPerformance.map((s: any) => <li key={s.name} className="flex justify-between"><span>{s.name} <span className="text-muted">({statusLabel(s.role)})</span></span><span>{s.actions} actions</span></li>)}</ul>}</Card>
              <Card className="p-4"><h3 className="mb-2 text-lg">Recent activity</h3>{d.recentActivity.length === 0 ? <p className="text-sm text-muted">Nothing yet.</p> : <ul className="space-y-1.5 text-sm">{d.recentActivity.map((a: any) => <li key={a.id}><span className="font-medium">{a.by}</span> · {a.action}<span className="block text-xs text-muted">{dateTime(a.at)}</span></li>)}</ul>}</Card>
            </div>
          </>); }}
      </QueryBoundary>
    </div>
  );
}
