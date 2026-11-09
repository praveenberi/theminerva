import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { Badge, Button, Card, ConfirmButton, Drawer, Field, Input, QueryBoundary, Select, useToast } from '@/components/ui';
import { api, download, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { dateOnly, dateTime, money, statusLabel } from '@/lib/format';
import { useSeo } from '@/lib/hooks';

const SEGMENTS = [['', 'All customers'], ['NEW', 'New (30 days)'], ['RETURNING', 'Returning'], ['VIP', 'VIP / tiered'], ['INACTIVE', 'Inactive (60+ days)'], ['HIGH_SPEND', 'High spending'], ['BIRTHDAY', 'Birthday this month']];

export default function Customers() {
  useSeo('Customers');
  const { can } = useAuth(); const toast = useToast();
  const [f, setF] = useState({ q: '', segment: '', page: 1 });
  const [open, setOpen] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['customers', f], queryFn: () => api('/api/customers', { query: { ...f, pageSize: 20 } }), placeholderData: (p) => p });
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <Input aria-label="Search customers" placeholder="Name, email or phone" className="w-64" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value, page: 1 })} />
        <Select aria-label="Segment" className="w-52" value={f.segment} onChange={(e) => setF({ ...f, segment: e.target.value, page: 1 })}>{SEGMENTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select>
        {can('customers.manage') && <Button variant="outline" className="ml-auto" onClick={() => download('/api/customers/export.csv', 'customers.csv').catch((e) => toast('error', errorMessage(e)))}><Download className="h-4 w-4" /> Export CSV</Button>}
      </div>
      <QueryBoundary q={q} empty={(d) => d.items.length === 0}>
        {(d) => (<>
          <Card className="overflow-x-auto"><table className="w-full text-sm"><thead className="border-b border-border text-left text-xs uppercase text-muted"><tr><th className="p-3">Name</th><th>Contact</th><th>Orders</th><th>Spend</th><th>Avg</th><th>Points</th><th>Last order</th></tr></thead>
            <tbody>{d.items.map((c: any) => <tr key={c.id} tabIndex={0} onClick={() => setOpen(c.id)} onKeyDown={(e) => e.key === 'Enter' && setOpen(c.id)} className="cursor-pointer border-b border-border/60 last:border-0 hover:bg-surface-2">
              <td className="p-3 font-medium">{c.name} {c.tier !== 'Member' && <Badge tone="brand">{c.tier}</Badge>} {c.tags.map((t: string) => <Badge key={t}>{t}</Badge>)}</td><td className="text-muted">{c.phone ?? c.email ?? '—'}</td><td>{c.orders}</td><td>{money(c.totalSpend)}</td><td>{money(c.avgSpend)}</td><td>{c.loyaltyPoints}</td><td>{c.lastOrderAt ? dateOnly(c.lastOrderAt) : '—'}</td></tr>)}</tbody></table></Card>
          <div className="flex items-center justify-between text-sm"><span className="text-muted">{d.total} customers</span><div className="flex gap-2"><Button size="sm" variant="outline" disabled={f.page <= 1} onClick={() => setF({ ...f, page: f.page - 1 })}>Previous</Button><span className="self-center">{d.page} / {d.pages}</span><Button size="sm" variant="outline" disabled={f.page >= d.pages} onClick={() => setF({ ...f, page: f.page + 1 })}>Next</Button></div></div></>)}
      </QueryBoundary>
      <CustomerDrawer id={open} onClose={() => setOpen(null)} />
    </div>
  );
}

function CustomerDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const qc = useQueryClient(); const toast = useToast(); const { can } = useAuth();
  const q = useQuery({ queryKey: ['customer', id], enabled: !!id, queryFn: () => api(`/api/customers/${id}`) });
  const [tag, setTag] = useState('');
  const [pts, setPts] = useState('');
  const refresh = () => { qc.invalidateQueries({ queryKey: ['customer', id] }); qc.invalidateQueries({ queryKey: ['customers'] }); };
  const save = useMutation({ mutationFn: (b: any) => api(`/api/customers/${id}`, { method: 'PUT', body: b }), onSuccess: refresh, onError: (e) => toast('error', errorMessage(e)) });
  const adjust = useMutation({ mutationFn: () => api(`/api/customers/${id}/points`, { body: { points: Number(pts), note: 'Manual adjustment' } }), onSuccess: () => { setPts(''); toast('success', 'Points updated'); refresh(); }, onError: (e) => toast('error', errorMessage(e)) });
  const erase = useMutation({ mutationFn: () => api(`/api/customers/${id}`, { method: 'DELETE' }), onSuccess: () => { toast('success', 'Customer data erased'); onClose(); refresh(); }, onError: (e) => toast('error', errorMessage(e)) });
  return (
    <Drawer open={!!id} onClose={onClose} title="Customer">
      <QueryBoundary q={q}>
        {(c) => (
          <div className="space-y-5 text-sm">
            <div><p className="font-display text-2xl">{c.name}</p><p className="text-muted">{c.email} {c.phone}</p><p className="text-muted">Member since {dateOnly(c.createdAt)} · {c.tier} · {c.loyaltyPoints} points</p>
              <p className="mt-1">{c.marketingConsent ? <Badge tone="success">Marketing opt-in</Badge> : <Badge>No marketing consent</Badge>}</p></div>
            <dl className="grid grid-cols-3 gap-2 text-center"><Card className="p-2"><dt className="text-xs text-muted">Orders</dt><dd className="text-lg font-semibold">{c.stats.orders}</dd></Card><Card className="p-2"><dt className="text-xs text-muted">Spend</dt><dd className="text-lg font-semibold">{money(c.stats.totalSpend ?? 0)}</dd></Card><Card className="p-2"><dt className="text-xs text-muted">Average</dt><dd className="text-lg font-semibold">{money(c.stats.avgSpend ?? 0)}</dd></Card></dl>
            {(c.allergies || c.preferences) && <div className="rounded-xl bg-warn/10 p-3">{c.allergies && <p><strong>Allergies:</strong> {c.allergies}</p>}{c.preferences && <p><strong>Preferences:</strong> {c.preferences}</p>}</div>}
            {can('customers.manage') && <><div><p className="mb-1 font-medium">Tags</p><div className="flex flex-wrap gap-1">{c.tags.map((t: string) => <button key={t} className="rounded-full bg-surface-2 px-2.5 py-0.5 text-xs" onClick={() => save.mutate({ tags: c.tags.filter((x: string) => x !== t) })}>{t} ×</button>)}</div><form className="mt-2 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (tag.trim()) { save.mutate({ tags: [...new Set([...c.tags, tag.trim()])] }); setTag(''); } }}><Input aria-label="New tag" placeholder="Add tag, e.g. VIP" value={tag} onChange={(e) => setTag(e.target.value)} /><Button size="sm" variant="outline">Add</Button></form></div>
              <form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); adjust.mutate(); }}><Field label="Adjust points (+/−)" className="flex-1">{(fid) => <Input id={fid} type="number" required value={pts} onChange={(e) => setPts(e.target.value)} />}</Field><Button loading={adjust.isPending}>Apply</Button></form></>}
            <section><h3 className="mb-1 font-medium">Recent orders</h3><ul className="divide-y divide-border">{c.orders.map((o: any) => <li key={o.id} className="flex justify-between py-1.5"><span>#{o.number} · {statusLabel(o.status)} · {dateTime(o.createdAt)}</span><span>{money(o.total)}</span></li>)}{c.orders.length === 0 && <li className="py-2 text-muted">No orders</li>}</ul></section>
            <section><h3 className="mb-1 font-medium">Loyalty history</h3><ul className="divide-y divide-border">{c.loyaltyTx.map((t: any) => <li key={t.id} className="flex justify-between py-1.5"><span>{statusLabel(t.reason)} · {dateTime(t.createdAt)}</span><span>{t.points > 0 ? '+' : ''}{t.points}</span></li>)}</ul></section>
            {can('customers.manage') && <ConfirmButton variant="ghost" className="text-danger" message="Erase this customer’s personal data (PDPA/GDPR request)? Order records are kept but anonymised. This cannot be undone." onConfirm={() => erase.mutate()}>Erase personal data</ConfirmButton>}
          </div>)}
      </QueryBoundary>
    </Drawer>
  );
}
