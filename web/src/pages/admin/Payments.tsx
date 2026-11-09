import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { Badge, Button, Card, Input, QueryBoundary, Select, useToast } from '@/components/ui';
import { api, download, errorMessage } from '@/lib/api';
import { dateTime, money, statusLabel } from '@/lib/format';
import { useSeo } from '@/lib/hooks';

const iso = (d: Date) => d.toISOString().slice(0, 10);

export default function Payments() {
  useSeo('Payments');
  const toast = useToast();
  const [f, setF] = useState({ status: '', method: '', page: 1 });
  const [range, setRange] = useState({ from: iso(new Date(Date.now() - 30 * 864e5)), to: iso(new Date()) });
  const q = useQuery({ queryKey: ['payments', f], queryFn: () => api('/api/payments', { query: { ...f, pageSize: 20 } }), placeholderData: (p) => p });
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-2">
        <Select aria-label="Status" className="w-40" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value, page: 1 })}><option value="">All statuses</option>{['PENDING', 'PAID', 'FAILED', 'PARTIALLY_REFUNDED', 'REFUNDED'].map((s) => <option key={s} value={s}>{statusLabel(s)}</option>)}</Select>
        <Select aria-label="Method" className="w-48" value={f.method} onChange={(e) => setF({ ...f, method: e.target.value, page: 1 })}><option value="">All methods</option>{['CARD', 'STRIPE', 'RAZORPAY', 'PAYNOW', 'UPI', 'CASH_ON_DELIVERY', 'CASH_AT_RESTAURANT'].map((s) => <option key={s} value={s}>{statusLabel(s)}</option>)}</Select>
        <div className="ml-auto flex items-end gap-2"><Input aria-label="From" type="date" className="w-40" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /><Input aria-label="To" type="date" className="w-40" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} />
          <Button variant="outline" onClick={() => download('/api/payments/settlement.csv', `settlement-${range.from}_${range.to}.csv`, { from: new Date(range.from).toISOString(), to: new Date(range.to + 'T23:59:59').toISOString() }).catch((e) => toast('error', errorMessage(e)))}><Download className="h-4 w-4" /> Settlement CSV</Button></div>
      </div>
      <QueryBoundary q={q} empty={(d) => d.items.length === 0}>
        {(d) => (<>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{d.summary.map((s: any, i: number) => <Card key={i} className="p-3"><p className="text-xs text-muted">{statusLabel(s.method)} · {statusLabel(s.status)}</p><p className="font-display text-xl">{money(s.amount)}</p><p className="text-xs text-muted">{s.count} payments</p></Card>)}</div>
          <Card className="overflow-x-auto"><table className="w-full text-sm"><thead className="border-b border-border text-left text-xs uppercase text-muted"><tr><th className="p-3">Date</th><th>Order</th><th>Method</th><th>Reference</th><th>Status</th><th className="pr-3 text-right">Amount</th></tr></thead>
            <tbody>{d.items.map((p: any) => <tr key={p.id} className="border-b border-border/60 last:border-0"><td className="p-3">{dateTime(p.createdAt)}</td><td>#{p.order.number}</td><td>{statusLabel(p.method)}</td><td className="font-mono text-xs">{p.reference.slice(-10)}</td><td><Badge tone={p.status === 'PAID' ? 'success' : p.status === 'FAILED' ? 'danger' : 'warn'}>{statusLabel(p.status)}</Badge></td><td className="pr-3 text-right">{money(p.amount)}{p.refunds.length > 0 && <span className="block text-xs text-danger">− {money(p.refunds.reduce((a: number, r: any) => a + Number(r.amount), 0))} refunded</span>}</td></tr>)}</tbody></table></Card>
          <div className="flex justify-end gap-2 text-sm"><Button size="sm" variant="outline" disabled={f.page <= 1} onClick={() => setF({ ...f, page: f.page - 1 })}>Previous</Button><span className="self-center">{d.page} / {d.pages}</span><Button size="sm" variant="outline" disabled={f.page >= d.pages} onClick={() => setF({ ...f, page: f.page + 1 })}>Next</Button></div></>)}
      </QueryBoundary>
      <p className="text-xs text-muted">Online payments are marked PAID only after the provider’s signed webhook is verified. Cash payments are confirmed by staff from the order screen. Issue refunds from the order.</p>
    </div>
  );
}
