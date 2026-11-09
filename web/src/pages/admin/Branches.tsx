import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { Badge, Button, Card, ConfirmButton, Drawer, EmptyState, Field, Input, Modal, QueryBoundary, Switch, useToast } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { money } from '@/lib/format';

export default function Branches() {
  const qc = useQueryClient(); const toast = useToast();
  const q = useQuery({ queryKey: ['outlets'], queryFn: () => api('/api/outlets') });
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api('/api/restaurant/settings') });
  const [f, setF] = useState<any>(null);
  const [prices, setPrices] = useState<any>(null);
  const refresh = () => { qc.invalidateQueries({ queryKey: ['outlets'] }); qc.invalidateQueries({ queryKey: ['public-outlets'] }); };
  const onError = (e: unknown) => toast('error', errorMessage(e));
  const save = useMutation({ mutationFn: (v: any) => { const b = { name: v.name, code: v.code, address: v.address || null, phone: v.phone || null, isActive: v.isActive ?? true }; return v.id ? api(`/api/outlets/${v.id}`, { method: 'PUT', body: b }) : api('/api/outlets', { body: b }); }, onSuccess: () => { setF(null); refresh(); toast('success', 'Branch saved'); }, onError });
  const del = useMutation({ mutationFn: (id: string) => api(`/api/outlets/${id}`, { method: 'DELETE' }), onSuccess: (r) => { toast('success', r.deactivated ? 'Branch has orders, so it was deactivated instead' : 'Branch deleted'); refresh(); }, onError });
  const toggle = useMutation({ mutationFn: (on: boolean) => api('/api/restaurant/settings', { method: 'PUT', body: { site: { multiOutlet: on } } }), onSuccess: () => { qc.invalidateQueries({ queryKey: ['settings'] }); refresh(); qc.invalidateQueries({ queryKey: ['home'] }); }, onError });
  const on = !!settings.data?.site.multiOutlet;
  return (
    <div className="max-w-4xl space-y-4">
      <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
        <div><p className="font-medium">Multiple branches</p><p className="text-sm text-muted">When on, customers choose a branch for takeaway and delivery, and branch filters appear in the dashboard. All branches share one menu, customer list and loyalty scheme. Leave off for a single restaurant.</p></div>
        <label className="flex items-center gap-2 text-sm"><Switch label="Multiple branches" checked={on} onChange={(v) => toggle.mutate(v)} />{on ? 'On' : 'Off'}</label>
      </Card>
      {on && (q.data?.filter((o: any) => o.isActive).length ?? 0) < 1 && <p className="rounded-xl bg-warn/10 p-3 text-sm text-warn">Multi-branch is on but no active branch exists, so online orders will fail. Add a branch first or switch it off.</p>}
      <Button onClick={() => setF({ name: '', code: '', isActive: true })}><Plus className="h-4 w-4" /> Add branch</Button>
      <QueryBoundary q={q} empty={(d) => d.length === 0}>
        {(d) => (
          <div className="grid gap-3 sm:grid-cols-2">{d.map((o: any) => (
            <Card key={o.id} className="space-y-2 p-4">
              <div className="flex items-start justify-between"><div><p className="font-medium">{o.name} <Badge>{o.code}</Badge> {!o.isActive && <Badge tone="warn">inactive</Badge>}</p><p className="text-sm text-muted">{o.address || 'No address'}</p></div></div>
              <p className="text-xs text-muted">{o._count.tables} tables · {o._count.users} staff · {o._count.orders} orders</p>
              <div className="flex flex-wrap gap-1"><Button size="sm" variant="outline" onClick={() => setPrices(o)}>Prices & availability</Button><Button size="sm" variant="ghost" onClick={() => setF({ ...o })}>Edit</Button>
                <ConfirmButton size="sm" variant="ghost" className="text-danger" message={`Remove ${o.name}? Branches with orders are deactivated instead; staff and tables are unassigned.`} onConfirm={() => del.mutate(o.id)}>Remove</ConfirmButton></div>
            </Card>))}</div>)}
      </QueryBoundary>
      <p className="text-xs text-muted">Assign tables to a branch under Tables & QR, and staff under Staff. Staff assigned to a branch only see that branch’s orders and dashboard.</p>
      <Modal open={!!f} onClose={() => setF(null)} title={f?.id ? 'Edit branch' : 'New branch'}>
        {f && <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); save.mutate(f); }}>
          <div className="grid grid-cols-2 gap-4"><Field label="Name">{(id) => <Input id={id} required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />}</Field><Field label="Code" hint="e.g. MRN">{(id) => <Input id={id} required value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} />}</Field></div>
          <Field label="Address">{(id) => <Input id={id} value={f.address ?? ''} onChange={(e) => setF({ ...f, address: e.target.value })} />}</Field>
          <Field label="Phone">{(id) => <Input id={id} value={f.phone ?? ''} onChange={(e) => setF({ ...f, phone: e.target.value })} />}</Field>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.isActive ?? true} onChange={(e) => setF({ ...f, isActive: e.target.checked })} /> Active (visible to customers)</label>
          <div className="flex justify-end"><Button loading={save.isPending}>Save</Button></div></form>}
      </Modal>
      <PriceDrawer outlet={prices} onClose={() => setPrices(null)} />
    </div>
  );
}

function PriceDrawer({ outlet, onClose }: { outlet: any; onClose: () => void }) {
  const qc = useQueryClient(); const toast = useToast();
  const q = useQuery({ queryKey: ['branch-products', outlet?.id], enabled: !!outlet, queryFn: () => api(`/api/outlets/${outlet.id}/products`) });
  const [edit, setEdit] = useState<Record<string, { price: string; isAvailable: boolean }>>({});
  const save = useMutation({
    mutationFn: ({ id, price, isAvailable }: any) => api(`/api/outlets/${outlet.id}/products/${id}`, { method: 'PUT', body: { price: price === '' ? null : Number(price), isAvailable } }),
    onSuccess: (_r, v) => { setEdit((e) => { const n = { ...e }; delete n[v.id]; return n; }); qc.invalidateQueries({ queryKey: ['branch-products', outlet.id] }); qc.invalidateQueries({ queryKey: ['menu'] }); toast('success', 'Saved'); },
    onError: (e) => toast('error', errorMessage(e)),
  });
  return (
    <Drawer open={!!outlet} onClose={onClose} title={outlet ? `${outlet.name} — prices` : ''}>
      <p className="mb-3 text-sm text-muted">Leave the price empty to use the main menu price. Unticking “Sold here” hides the dish at this branch only.</p>
      <QueryBoundary q={q} empty={(d) => d.length === 0}>
        {(d) => <ul className="divide-y divide-border">{d.map((p: any) => { const e = edit[p.id] ?? { price: p.branchPrice == null ? '' : String(Number(p.branchPrice)), isAvailable: p.branchAvailable }; const dirty = !!edit[p.id];
          return (<li key={p.id} className="flex flex-wrap items-center gap-2 py-2 text-sm"><span className="min-w-0 flex-1"><span className="font-medium">{p.name}</span><span className="block text-xs text-muted">{p.category.name} · main {money(p.price)}</span></span>
            <Input aria-label={`${p.name} branch price`} type="number" step="0.01" min="0" placeholder="main" className="w-24" value={e.price} onChange={(ev) => setEdit({ ...edit, [p.id]: { ...e, price: ev.target.value } })} />
            <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={e.isAvailable} onChange={(ev) => setEdit({ ...edit, [p.id]: { ...e, isAvailable: ev.target.checked } })} />Sold here</label>
            {dirty && <Button size="sm" loading={save.isPending && save.variables?.id === p.id} onClick={() => save.mutate({ id: p.id, ...e })}>Save</Button>}</li>); })}</ul>}
      </QueryBoundary>
    </Drawer>
  );
}
void EmptyState;
