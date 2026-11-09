import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BellRing, Download, Plus, Receipt } from 'lucide-react';
import { Badge, Button, Card, ConfirmButton, Drawer, ErrorState, Field, Input, Modal, QueryBoundary, Select, Tabs, useToast } from '@/components/ui';
import { api, download, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn, money, statusLabel } from '@/lib/format';
import { useSeo } from '@/lib/hooks';
import { useOutletFilter } from '@/lib/outlet';

const COLORS: Record<string, string> = { AVAILABLE: 'border-success/60 bg-success/10', OCCUPIED: 'border-danger/60 bg-danger/10', RESERVED: 'border-warn/60 bg-warn/10', CLEANING: 'border-border bg-surface-2' };

export default function Tables() {
  useSeo('Tables & QR');
  const qc = useQueryClient(); const toast = useToast(); const { can } = useAuth();
  const q = useQuery({ queryKey: ['tables'], queryFn: () => api('/api/tables'), refetchInterval: 20_000 });
  const { all: branches, outletId: filterBranch } = useOutletFilter();
  const [sel, setSel] = useState<string | null>(null);
  const [form, setForm] = useState<any>(null);
  const [tab, setTab] = useState<'floor' | 'qr'>('floor');
  const manage = can('settings.manage') || can('menu.manage') || can('staff.manage') || can('tables.manage') && !can('payments.refund') && false;
  const canEditLayout = can('staff.manage'); // owner / manager
  const save = useMutation({ mutationFn: (t: any) => (t.id ? api(`/api/tables/${t.id}`, { method: 'PUT', body: { label: t.label, capacity: Number(t.capacity), zone: t.zone || null, isActive: t.isActive ?? true, outletId: t.outletId || null } }) : api('/api/tables', { body: { label: t.label, capacity: Number(t.capacity), zone: t.zone || null, outletId: t.outletId || null, posX: 40, posY: 40 } })), onSuccess: () => { setForm(null); qc.invalidateQueries({ queryKey: ['tables'] }); toast('success', 'Table saved'); }, onError: (e) => toast('error', errorMessage(e)) });
  const move = useMutation({ mutationFn: ({ id, posX, posY }: any) => api(`/api/tables/${id}`, { method: 'PUT', body: { posX, posY } }), onSuccess: () => qc.invalidateQueries({ queryKey: ['tables'] }), onError: (e) => toast('error', errorMessage(e)) });
  const del = useMutation({ mutationFn: (id: string) => api(`/api/tables/${id}`, { method: 'DELETE' }), onSuccess: () => { setSel(null); qc.invalidateQueries({ queryKey: ['tables'] }); }, onError: (e) => toast('error', errorMessage(e)) });
  const area = useRef<HTMLDivElement>(null);
  const dragging = useRef<{ id: string; dx: number; dy: number } | null>(null);
  const [pos, setPos] = useState<Record<string, { x: number; y: number }>>({});
  void manage;

  const onDown = (e: React.PointerEvent, t: any) => { if (!canEditLayout) return; const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); dragging.current = { id: t.id, dx: e.clientX - r.left, dy: e.clientY - r.top }; (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); };
  const onMove = (e: React.PointerEvent) => { const d = dragging.current; if (!d || !area.current) return; const r = area.current.getBoundingClientRect(); setPos((p) => ({ ...p, [d.id]: { x: Math.max(0, Math.min(r.width - 90, e.clientX - r.left - d.dx)), y: Math.max(0, Math.min(r.height - 90, e.clientY - r.top - d.dy)) } })); };
  const onUp = () => { const d = dragging.current; dragging.current = null; if (d && pos[d.id]) move.mutate({ id: d.id, posX: Math.round(pos[d.id].x), posY: Math.round(pos[d.id].y) }); };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3"><Tabs value={tab} onChange={setTab} tabs={[{ id: 'floor', label: 'Floor plan' }, { id: 'qr', label: 'QR codes' }]} />
        {canEditLayout && <Button onClick={() => setForm({ label: '', capacity: 2 })}><Plus className="h-4 w-4" /> Add table</Button>}</div>
      <QueryBoundary q={q} empty={(d) => d.length === 0}>
        {(tables) => tab === 'floor' ? (
          <>
            <div className="flex flex-wrap gap-3 text-xs">{Object.keys(COLORS).map((s) => <span key={s} className="flex items-center gap-1"><span className={cn('h-3 w-3 rounded border', COLORS[s])} />{statusLabel(s)}</span>)}{canEditLayout && <span className="text-muted">Drag tables to arrange the floor plan.</span>}</div>
            <div ref={area} onPointerMove={onMove} onPointerUp={onUp} className="relative h-[460px] overflow-auto rounded-2xl border border-border bg-[radial-gradient(hsl(var(--border))_1px,transparent_1px)] [background-size:20px_20px]" role="application" aria-label="Floor plan">
              {tables.filter((t: any) => t.isActive && (!filterBranch || t.outletId === filterBranch)).map((t: any) => { const p = pos[t.id] ?? { x: t.posX, y: t.posY };
                return (
                  <button key={t.id} onPointerDown={(e) => onDown(e, t)} onClick={() => setSel(t.id)} style={{ left: p.x, top: p.y, touchAction: 'none' }}
                    className={cn('absolute grid h-[84px] w-[84px] place-items-center rounded-2xl border-2 text-center shadow-sm', COLORS[t.status], t.capacity > 4 && 'w-[120px]')}>
                    <span><span className="block font-display text-xl">{t.label}</span><span className="block text-xs text-muted">{t.capacity} seats</span>{t.session?.billRequestedAt && <Receipt className="mx-auto h-3.5 w-3.5 text-warn" aria-label="Bill requested" />}{t.session?.waiterCalledAt && <BellRing className="mx-auto h-3.5 w-3.5 text-danger" aria-label="Needs assistance" />}</span>
                  </button>); })}
            </div>
          </>
        ) : (
          <div className="space-y-6">
            <Card className="p-4"><h3 className="mb-3 text-lg">General QR codes</h3><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{[['main', 'Restaurant (main)'], ['takeaway', 'Takeaway'], ['event', 'Events'], ['private-dining', 'Private dining']].map(([t, l]) => <QrRow key={t} label={l} type={t} />)}</div></Card>
            <Card className="p-4"><h3 className="mb-3 text-lg">Table QR codes</h3><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{tables.filter((t: any) => t.isActive).map((t: any) => <QrRow key={t.id} label={`Table ${t.label}`} type="table" id={t.id} />)}</div><p className="mt-3 text-xs text-muted">Each table code opens the menu with that table pre-selected. Print the PDF and place it on the table.</p></Card>
          </div>)}
      </QueryBoundary>
      <TableDrawer id={sel} tables={q.data ?? []} onClose={() => setSel(null)} onEdit={(t) => { setSel(null); setForm(t); }} onDelete={(id) => del.mutate(id)} canEdit={canEditLayout} />
      <Modal open={!!form} onClose={() => setForm(null)} title={form?.id ? `Edit table ${form.label}` : 'Add table'}>
        {form && <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); save.mutate(form); }}>
          <Field label="Label">{(id) => <Input id={id} required maxLength={20} value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} />}</Field>
          <div className="grid grid-cols-2 gap-4">{branches.length > 0 && <Field label="Branch" className="col-span-2">{(id) => <Select id={id} value={form.outletId ?? ''} onChange={(e) => setForm({ ...form, outletId: e.target.value })}><option value="">Unassigned</option>{branches.filter((b: any) => b.isActive).map((b: any) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select>}</Field>}<Field label="Seats">{(id) => <Input id={id} type="number" min={1} max={50} required value={form.capacity} onChange={(e) => setForm({ ...form, capacity: e.target.value })} />}</Field><Field label="Zone (optional)">{(id) => <Input id={id} value={form.zone ?? ''} onChange={(e) => setForm({ ...form, zone: e.target.value })} />}</Field></div>
          <div className="flex justify-end"><Button loading={save.isPending}>Save</Button></div></form>}
      </Modal>
    </div>
  );
}

function QrRow({ label, type, id }: { label: string; type: string; id?: string }) {
  const toast = useToast();
  const dl = (fmt: string) => download(`/api/qr/${type}.${fmt}`, `qr-${label.replace(/\s+/g, '-').toLowerCase()}.${fmt}`, { id }).catch((e) => toast('error', errorMessage(e)));
  return <div className="rounded-xl border border-border p-3"><p className="mb-2 font-medium">{label}</p><div className="flex gap-1">{['png', 'svg', 'pdf'].map((f) => <Button key={f} size="sm" variant="outline" onClick={() => dl(f)}><Download className="h-3.5 w-3.5" /> {f.toUpperCase()}</Button>)}</div></div>;
}

function TableDrawer({ id, tables, onClose, onEdit, onDelete, canEdit }: { id: string | null; tables: any[]; onClose: () => void; onEdit: (t: any) => void; onDelete: (id: string) => void; canEdit: boolean }) {
  const qc = useQueryClient(); const toast = useToast(); const { can } = useAuth();
  const t = tables.find((x) => x.id === id);
  const [split, setSplit] = useState(1);
  const [newOrder, setNewOrder] = useState(false);
  const bill = useQuery({ queryKey: ['bill', id, split], enabled: !!t?.session, queryFn: () => api(`/api/tables/${id}/bill`, { query: { split } }), retry: false });
  const setStatus = useMutation({ mutationFn: (status: string) => api(`/api/tables/${id}`, { method: 'PUT', body: { status } }), onSuccess: () => qc.invalidateQueries({ queryKey: ['tables'] }), onError: (e) => toast('error', errorMessage(e)) });
  const close = useMutation({ mutationFn: (force: boolean) => api(`/api/tables/${id}/close-session${force ? '?force=true' : ''}`, { body: {} }), onSuccess: () => { toast('success', 'Table session closed'); qc.invalidateQueries({ queryKey: ['tables'] }); }, onError: (e) => toast('error', errorMessage(e)) });
  return (
    <Drawer open={!!id} onClose={onClose} title={t ? `Table ${t.label}` : 'Table'}>
      {t && (
        <div className="space-y-5 text-sm">
          <div className="flex flex-wrap items-center gap-2"><Badge>{t.capacity} seats</Badge>{t.zone && <Badge>{t.zone}</Badge>}<Select aria-label="Status" className="w-40" value={t.status} onChange={(e) => setStatus.mutate(e.target.value)}>{['AVAILABLE', 'OCCUPIED', 'RESERVED', 'CLEANING'].map((s) => <option key={s} value={s}>{statusLabel(s)}</option>)}</Select></div>
          {t.session?.waiterCalledAt && <p className="rounded-xl bg-danger/10 p-3 text-danger">This table asked for assistance.</p>}
          {t.session?.billRequestedAt && <p className="rounded-xl bg-warn/10 p-3 text-warn">Bill requested.</p>}
          <Button onClick={() => setNewOrder(true)} disabled={!can('orders.create')}><Plus className="h-4 w-4" /> New order for this table</Button>
          {t.session ? (
            <section className="space-y-3"><h3 className="font-medium">Running bill</h3>
              <QueryBoundary q={bill}>{(b) => (<>
                <ul className="space-y-1">{b.orders.map((o: any) => <li key={o.id} className="flex justify-between"><span>#{o.number} · {statusLabel(o.status)}</span><span>{money(o.total)}</span></li>)}</ul>
                <div className="space-y-1 border-t border-border pt-2"><div className="flex justify-between"><span>Total</span><span>{money(b.total)}</span></div><div className="flex justify-between"><span>Paid</span><span>{money(b.paid)}</span></div><div className="flex justify-between font-semibold"><span>Due</span><span>{money(b.due)}</span></div></div>
                <div className="flex items-center gap-2"><label htmlFor="split" className="text-sm">Split between</label><Input id="split" type="number" min={1} max={20} className="w-20" value={split} onChange={(e) => setSplit(Math.max(1, Math.min(20, +e.target.value || 1)))} /></div>
                {split > 1 && <ul className="text-sm">{b.shares.map((s: number, i: number) => <li key={i}>Guest {i + 1}: {money(s)}</li>)}</ul>}</>)}</QueryBoundary>
              <div className="flex gap-2"><Button variant="outline" onClick={() => close.mutate(false)} loading={close.isPending}>Close session</Button>{can('staff.manage') && <ConfirmButton variant="ghost" className="text-danger" message="Force-close even though the bill is not fully paid?" onConfirm={() => close.mutate(true)}>Force close</ConfirmButton>}</div>
              <p className="text-xs text-muted">Record payments from the Orders screen (open each order → payments).</p>
            </section>) : <p className="text-muted">No open session.</p>}
          {canEdit && <div className="flex gap-2 border-t border-border pt-3"><Button variant="outline" size="sm" onClick={() => onEdit(t)}>Edit table</Button><ConfirmButton size="sm" variant="ghost" className="text-danger" message="Delete this table? Tables with history are archived instead." onConfirm={() => onDelete(t.id)}>Delete</ConfirmButton></div>}
          <StaffOrder open={newOrder} table={t} onClose={() => setNewOrder(false)} onDone={() => { setNewOrder(false); qc.invalidateQueries({ queryKey: ['tables'] }); qc.invalidateQueries({ queryKey: ['board'] }); }} />
        </div>)}
    </Drawer>
  );
}

function StaffOrder({ open, table, onClose, onDone }: { open: boolean; table: any; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const menu = useQuery({ queryKey: ['menu-for-staff'], enabled: open, queryFn: () => api('/api/public/menu') });
  const [lines, setLines] = useState<Record<string, { p: any; variantId?: string; addonIds: string[]; qty: number }>>({});
  const [search, setSearch] = useState('');
  const submit = useMutation({
    mutationFn: () => {
      const items = Object.values(lines).filter((l) => l.qty > 0).map((l) => ({ productId: l.p.id, variantId: l.variantId, addonIds: l.addonIds, quantity: l.qty }));
      return api('/api/orders', { body: { type: 'DINE_IN', tableId: table.id, items, guest: { name: `Table ${table.label}` } } });
    },
    onSuccess: (o) => { toast('success', `Order #${o.number} sent to the kitchen`); setLines({}); onDone(); }, onError: (e) => toast('error', errorMessage(e)),
  });
  const products: any[] = (menu.data ?? []).flatMap((m: any) => m.categories.flatMap((c: any) => c.products)).filter((p: any) => p.orderable && p.name.toLowerCase().includes(search.toLowerCase()));
  const upd = (p: any, patch: any) => setLines((l) => ({ ...l, [p.id]: { ...({ addonIds: [], qty: 0, variantId: p.variants[0]?.id } as any), ...(l[p.id] as any), ...patch, p } }));
  const count = Object.values(lines).reduce((a, l) => a + l.qty, 0);
  return (
    <Modal open={open} onClose={onClose} title={`New order · Table ${table.label}`} wide>
      <Input aria-label="Search dishes" placeholder="Search dishes…" className="mb-3" value={search} onChange={(e) => setSearch(e.target.value)} />
      {menu.error ? <ErrorState error={menu.error} /> : (
        <ul className="max-h-[50vh] divide-y divide-border overflow-y-auto">{products.map((p) => { const l = lines[p.id]; return (
          <li key={p.id} className="flex flex-wrap items-center gap-2 py-2"><span className="min-w-0 flex-1"><span className="font-medium">{p.name}</span> <span className="text-muted">{money(p.discountPrice ?? p.price)}</span></span>
            {p.variants.length > 0 && <Select aria-label={`${p.name} size`} className="w-32" value={l?.variantId ?? p.variants[0].id} onChange={(e) => upd(p, { variantId: e.target.value })}>{p.variants.map((v: any) => <option key={v.id} value={v.id}>{v.name}</option>)}</Select>}
            {p.addonGroups.flatMap((g: any) => g.addons).map((a: any) => <label key={a.id} className="flex items-center gap-1 text-xs"><input type="checkbox" checked={l?.addonIds.includes(a.id) ?? false} onChange={(e) => upd(p, { addonIds: e.target.checked ? [...(l?.addonIds ?? []), a.id] : (l?.addonIds ?? []).filter((x) => x !== a.id) })} />{a.name}</label>)}
            <div className="flex items-center gap-1"><Button type="button" size="icon" variant="outline" aria-label={`Remove one ${p.name}`} onClick={() => upd(p, { qty: Math.max(0, (l?.qty ?? 0) - 1) })}>−</Button><span className="w-6 text-center">{l?.qty ?? 0}</span><Button type="button" size="icon" variant="outline" aria-label={`Add one ${p.name}`} onClick={() => upd(p, { qty: (l?.qty ?? 0) + 1 })}>+</Button></div></li>); })}</ul>)}
      <div className="mt-4 flex justify-end"><Button loading={submit.isPending} disabled={!count} onClick={() => submit.mutate()}>Send {count || ''} item{count === 1 ? '' : 's'} to kitchen</Button></div>
    </Modal>
  );
}
