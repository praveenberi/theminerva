import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Plus } from 'lucide-react';
import { Badge, Button, Card, ConfirmButton, Drawer, EmptyState, Field, Input, Modal, QueryBoundary, Select, Tabs, useToast } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { dateOnly, dateTime, money, statusLabel } from '@/lib/format';
import { useSeo } from '@/lib/hooks';

type Tab = 'stock' | 'suppliers' | 'orders' | 'reorder';

export default function Inventory() {
  useSeo('Inventory');
  const [tab, setTab] = useState<Tab>('stock');
  return (
    <div className="space-y-4">
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'stock', label: 'Stock' }, { id: 'suppliers', label: 'Suppliers' }, { id: 'orders', label: 'Purchase orders' }, { id: 'reorder', label: 'Reorder suggestions' }]} />
      {tab === 'stock' ? <Stock /> : tab === 'suppliers' ? <Suppliers /> : tab === 'orders' ? <PurchaseOrders /> : <Reorder />}
    </div>
  );
}

function Stock() {
  const qc = useQueryClient(); const toast = useToast();
  const [low, setLow] = useState(false);
  const [q2, setQ2] = useState('');
  const q = useQuery({ queryKey: ['inventory', low, q2], queryFn: () => api('/api/inventory', { query: { low: low ? 'true' : undefined, q: q2, pageSize: 200 } }) });
  const sup = useQuery({ queryKey: ['suppliers'], queryFn: () => api('/api/inventory/suppliers/all') });
  const [form, setForm] = useState<any>(null);
  const [move, setMove] = useState<any>(null);
  const [hist, setHist] = useState<any>(null);
  const refresh = () => { qc.invalidateQueries({ queryKey: ['inventory'] }); qc.invalidateQueries({ queryKey: ['ingredients-all'] }); };
  const save = useMutation({ mutationFn: (v: any) => { const b = { name: v.name, unit: v.unit, reorderLevel: Number(v.reorderLevel), costPerUnit: Number(v.costPerUnit), supplierId: v.supplierId || null, expiresOn: v.expiresOn || null }; return v.id ? api(`/api/inventory/${v.id}`, { method: 'PUT', body: b }) : api('/api/inventory', { body: { ...b, stock: Number(v.stock || 0) } }); }, onSuccess: () => { setForm(null); refresh(); toast('success', 'Saved'); }, onError: (e) => toast('error', errorMessage(e)) });
  const doMove = useMutation({ mutationFn: (v: any) => api(`/api/inventory/${v.id}/move`, { body: { type: v.type, quantity: Number(v.quantity), note: v.note || undefined } }), onSuccess: () => { setMove(null); refresh(); toast('success', 'Stock updated'); }, onError: (e) => toast('error', errorMessage(e)) });
  const del = useMutation({ mutationFn: (id: string) => api(`/api/inventory/${id}`, { method: 'DELETE' }), onSuccess: refresh, onError: (e) => toast('error', errorMessage(e)) });
  const history = useQuery({ queryKey: ['stock-history', hist?.id], enabled: !!hist, queryFn: () => api(`/api/inventory/${hist.id}/history`) });
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2"><Input aria-label="Search" placeholder="Search ingredients" className="w-60" value={q2} onChange={(e) => setQ2(e.target.value)} />
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={low} onChange={(e) => setLow(e.target.checked)} /> Low stock only {q.data?.lowCount ? <Badge tone="warn">{q.data.lowCount}</Badge> : null}</label>
        <Button className="ml-auto" onClick={() => setForm({ name: '', unit: 'kg', stock: 0, reorderLevel: 0, costPerUnit: 0 })}><Plus className="h-4 w-4" /> Ingredient</Button></div>
      <QueryBoundary q={q} empty={(d) => d.items.length === 0}>
        {(d) => (
          <Card className="overflow-x-auto"><table className="w-full text-sm"><thead className="border-b border-border text-left text-xs uppercase text-muted"><tr><th className="p-3">Ingredient</th><th>Stock</th><th>Reorder at</th><th>Cost/unit</th><th>Supplier</th><th>Expiry</th><th /></tr></thead>
            <tbody>{d.items.map((i: any) => <tr key={i.id} className="border-b border-border/60 last:border-0"><td className="p-3 font-medium">{i.name} {i.isLow && <AlertTriangle className="inline h-4 w-4 text-warn" aria-label="Low stock" />}</td><td className={i.isLow ? 'font-semibold text-warn' : ''}>{Number(i.stock)} {i.unit}</td><td>{Number(i.reorderLevel)}</td><td>{money(i.costPerUnit)}</td><td>{i.supplier?.name ?? '—'}</td><td>{i.expiresOn ? <span className={i.expiringSoon ? 'text-danger' : ''}>{dateOnly(i.expiresOn)}</span> : '—'}</td>
              <td className="space-x-1 whitespace-nowrap py-2 pr-3 text-right"><Button size="sm" variant="outline" onClick={() => setMove({ id: i.id, name: i.name, unit: i.unit, type: 'RECEIPT', quantity: '' })}>Adjust</Button><Button size="sm" variant="ghost" onClick={() => setHist(i)}>History</Button><Button size="sm" variant="ghost" onClick={() => setForm({ ...i, supplierId: i.supplierId ?? '', expiresOn: i.expiresOn?.slice(0, 10) ?? '' })}>Edit</Button><ConfirmButton size="sm" variant="ghost" className="text-danger" message={`Delete ${i.name}?`} onConfirm={() => del.mutate(i.id)}>×</ConfirmButton></td></tr>)}</tbody></table></Card>)}
      </QueryBoundary>
      <Modal open={!!form} onClose={() => setForm(null)} title={form?.id ? 'Edit ingredient' : 'New ingredient'}>
        {form && <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); save.mutate(form); }}>
          <div className="grid grid-cols-2 gap-4"><Field label="Name">{(id) => <Input id={id} required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />}</Field><Field label="Unit">{(id) => <Input id={id} required maxLength={12} value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} />}</Field>
            {!form.id && <Field label="Opening stock">{(id) => <Input id={id} type="number" min={0} step="0.001" value={form.stock} onChange={(e) => setForm({ ...form, stock: e.target.value })} />}</Field>}
            <Field label="Reorder level">{(id) => <Input id={id} type="number" min={0} step="0.001" value={form.reorderLevel} onChange={(e) => setForm({ ...form, reorderLevel: e.target.value })} />}</Field>
            <Field label="Cost per unit">{(id) => <Input id={id} type="number" min={0} step="0.0001" value={form.costPerUnit} onChange={(e) => setForm({ ...form, costPerUnit: e.target.value })} />}</Field>
            <Field label="Expiry date">{(id) => <Input id={id} type="date" value={form.expiresOn} onChange={(e) => setForm({ ...form, expiresOn: e.target.value })} />}</Field>
            <Field label="Supplier" className="col-span-2">{(id) => <Select id={id} value={form.supplierId} onChange={(e) => setForm({ ...form, supplierId: e.target.value })}><option value="">None</option>{(sup.data ?? []).map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>}</Field></div>
          <div className="flex justify-end"><Button loading={save.isPending}>Save</Button></div></form>}
      </Modal>
      <Modal open={!!move} onClose={() => setMove(null)} title={`Adjust ${move?.name ?? ''}`}>
        {move && <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); doMove.mutate(move); }}>
          <Field label="Action">{(id) => <Select id={id} value={move.type} onChange={(e) => setMove({ ...move, type: e.target.value })}><option value="RECEIPT">Stock received (+)</option><option value="WASTAGE">Wastage (−)</option><option value="ADJUSTMENT">Manual adjustment (+/−)</option><option value="RECONCILIATION">Stock count (set total)</option></Select>}</Field>
          <Field label={`Quantity (${move.unit})`} hint={move.type === 'RECONCILIATION' ? 'Enter the counted total' : move.type === 'ADJUSTMENT' ? 'Use a negative number to reduce' : undefined}>{(id) => <Input id={id} type="number" step="0.001" required value={move.quantity} onChange={(e) => setMove({ ...move, quantity: e.target.value })} />}</Field>
          <Field label="Note">{(id) => <Input id={id} value={move.note ?? ''} onChange={(e) => setMove({ ...move, note: e.target.value })} />}</Field>
          <div className="flex justify-end"><Button loading={doMove.isPending}>Apply</Button></div></form>}
      </Modal>
      <Drawer open={!!hist} onClose={() => setHist(null)} title={`${hist?.name ?? ''} history`}>
        <QueryBoundary q={history} empty={(d) => d.length === 0}>{(d) => <ul className="divide-y divide-border text-sm">{d.map((m: any) => <li key={m.id} className="flex justify-between py-2"><span>{statusLabel(m.type)}<span className="block text-xs text-muted">{dateTime(m.createdAt)}{m.note && ` · ${m.note}`}</span></span><span className={Number(m.quantity) < 0 ? 'text-danger' : 'text-success'}>{Number(m.quantity) > 0 ? '+' : ''}{Number(m.quantity)}</span></li>)}</ul>}</QueryBoundary>
      </Drawer>
    </div>
  );
}

function Suppliers() {
  const qc = useQueryClient(); const toast = useToast();
  const q = useQuery({ queryKey: ['suppliers'], queryFn: () => api('/api/inventory/suppliers/all') });
  const [form, setForm] = useState<any>(null);
  const save = useMutation({ mutationFn: (v: any) => { const b = { name: v.name, contact: v.contact || null, phone: v.phone || null, email: v.email || '' }; return v.id ? api(`/api/inventory/suppliers/${v.id}`, { method: 'PUT', body: b }) : api('/api/inventory/suppliers', { body: b }); }, onSuccess: () => { setForm(null); qc.invalidateQueries({ queryKey: ['suppliers'] }); }, onError: (e) => toast('error', errorMessage(e)) });
  const del = useMutation({ mutationFn: (id: string) => api(`/api/inventory/suppliers/${id}`, { method: 'DELETE' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['suppliers'] }), onError: (e) => toast('error', errorMessage(e)) });
  return (
    <div className="space-y-4"><Button onClick={() => setForm({ name: '' })}><Plus className="h-4 w-4" /> Supplier</Button>
      <QueryBoundary q={q} empty={(d) => d.length === 0}>{(d) => <div className="grid gap-3 sm:grid-cols-2">{d.map((s: any) => <Card key={s.id} className="flex items-start justify-between p-4"><div><p className="font-medium">{s.name}</p><p className="text-sm text-muted">{[s.contact, s.phone, s.email].filter(Boolean).join(' · ') || 'No contact details'}</p></div><div><Button size="sm" variant="ghost" onClick={() => setForm({ ...s, email: s.email ?? '' })}>Edit</Button><ConfirmButton size="sm" variant="ghost" className="text-danger" message={`Delete ${s.name}?`} onConfirm={() => del.mutate(s.id)}>×</ConfirmButton></div></Card>)}</div>}</QueryBoundary>
      <Modal open={!!form} onClose={() => setForm(null)} title={form?.id ? 'Edit supplier' : 'New supplier'}>{form && <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); save.mutate(form); }}>
        <Field label="Name">{(id) => <Input id={id} required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />}</Field><Field label="Contact person">{(id) => <Input id={id} value={form.contact ?? ''} onChange={(e) => setForm({ ...form, contact: e.target.value })} />}</Field>
        <div className="grid grid-cols-2 gap-4"><Field label="Phone">{(id) => <Input id={id} value={form.phone ?? ''} onChange={(e) => setForm({ ...form, phone: e.target.value })} />}</Field><Field label="Email">{(id) => <Input id={id} type="email" value={form.email ?? ''} onChange={(e) => setForm({ ...form, email: e.target.value })} />}</Field></div>
        <div className="flex justify-end"><Button loading={save.isPending}>Save</Button></div></form>}</Modal></div>
  );
}

function PurchaseOrders() {
  const qc = useQueryClient(); const toast = useToast();
  const q = useQuery({ queryKey: ['pos'], queryFn: () => api('/api/inventory/purchase-orders/all') });
  const sup = useQuery({ queryKey: ['suppliers'], queryFn: () => api('/api/inventory/suppliers/all') });
  const ing = useQuery({ queryKey: ['ingredients-all'], queryFn: () => api('/api/inventory', { query: { pageSize: 200 } }) });
  const [form, setForm] = useState<any>(null);
  const create = useMutation({ mutationFn: () => api('/api/inventory/purchase-orders', { body: { supplierId: form.supplierId, lines: form.lines.filter((l: any) => l.ingredientId).map((l: any) => ({ ingredientId: l.ingredientId, quantity: Number(l.quantity), unitCost: Number(l.unitCost) })) } }), onSuccess: () => { setForm(null); qc.invalidateQueries({ queryKey: ['pos'] }); toast('success', 'Purchase order created'); }, onError: (e) => toast('error', errorMessage(e)) });
  const receive = useMutation({ mutationFn: (id: string) => api(`/api/inventory/purchase-orders/${id}/receive`, { body: {} }), onSuccess: () => { qc.invalidateQueries({ queryKey: ['pos'] }); qc.invalidateQueries({ queryKey: ['inventory'] }); toast('success', 'Stock received'); }, onError: (e) => toast('error', errorMessage(e)) });
  return (
    <div className="space-y-4"><Button onClick={() => setForm({ supplierId: sup.data?.[0]?.id ?? '', lines: [{ ingredientId: '', quantity: 1, unitCost: 0 }] })} disabled={!sup.data?.length}><Plus className="h-4 w-4" /> Purchase order</Button>
      {!sup.data?.length && <p className="text-sm text-muted">Add a supplier first.</p>}
      <QueryBoundary q={q} empty={(d) => d.length === 0}>{(d) => <ul className="space-y-3">{d.map((po: any) => <Card key={po.id} className="p-4"><div className="flex items-center justify-between"><p className="font-medium">{po.supplier.name} <span className="text-sm text-muted">· {dateTime(po.createdAt)}</span></p><div className="flex items-center gap-2"><Badge tone={po.status === 'RECEIVED' ? 'success' : 'warn'}>{statusLabel(po.status)}</Badge>{po.status === 'SENT' && <Button size="sm" loading={receive.isPending} onClick={() => receive.mutate(po.id)}>Receive all</Button>}</div></div><ul className="mt-2 text-sm text-muted">{po.lines.map((l: any) => <li key={l.id}>{Number(l.quantity)} {l.ingredient.unit} {l.ingredient.name} @ {money(l.unitCost)}</li>)}</ul></Card>)}</ul>}</QueryBoundary>
      <Modal open={!!form} onClose={() => setForm(null)} title="New purchase order" wide>{form && <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
        <Field label="Supplier">{(id) => <Select id={id} value={form.supplierId} onChange={(e) => setForm({ ...form, supplierId: e.target.value })}>{(sup.data ?? []).map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>}</Field>
        {form.lines.map((l: any, i: number) => <div key={i} className="flex gap-2"><Select aria-label="Ingredient" value={l.ingredientId} onChange={(e) => setForm({ ...form, lines: form.lines.map((x: any, j: number) => (j === i ? { ...x, ingredientId: e.target.value } : x)) })}><option value="">Ingredient…</option>{(ing.data?.items ?? []).map((g: any) => <option key={g.id} value={g.id}>{g.name} ({g.unit})</option>)}</Select><Input aria-label="Quantity" type="number" min="0.001" step="0.001" className="w-28" value={l.quantity} onChange={(e) => setForm({ ...form, lines: form.lines.map((x: any, j: number) => (j === i ? { ...x, quantity: e.target.value } : x)) })} /><Input aria-label="Unit cost" type="number" min="0" step="0.0001" className="w-28" value={l.unitCost} onChange={(e) => setForm({ ...form, lines: form.lines.map((x: any, j: number) => (j === i ? { ...x, unitCost: e.target.value } : x)) })} /></div>)}
        <Button type="button" variant="outline" size="sm" onClick={() => setForm({ ...form, lines: [...form.lines, { ingredientId: '', quantity: 1, unitCost: 0 }] })}>Add line</Button>
        <div className="flex justify-end"><Button loading={create.isPending}>Create</Button></div></form>}</Modal></div>
  );
}

function Reorder() {
  const q = useQuery({ queryKey: ['reorder'], queryFn: () => api('/api/inventory/reorder/suggestions') });
  return <QueryBoundary q={q} empty={(d) => d.length === 0}>{(d) => <Card className="overflow-x-auto"><table className="w-full text-sm"><thead className="border-b border-border text-left text-xs uppercase text-muted"><tr><th className="p-3">Ingredient</th><th>In stock</th><th>Avg daily use (14d)</th><th>Suggested order</th></tr></thead><tbody>{d.map((s: any) => <tr key={s.ingredientId} className="border-b border-border/60 last:border-0"><td className="p-3">{s.name}</td><td>{s.stock} {s.unit}</td><td>{s.avgDailyUse}</td><td className="font-semibold">{s.suggestedOrder} {s.unit}</td></tr>)}</tbody></table><p className="p-3 text-xs text-muted">Calculated from your stock ledger: 7 days of cover based on the last 14 days of consumption, or twice the reorder level.</p></Card>}</QueryBoundary>;
}
void EmptyState;
