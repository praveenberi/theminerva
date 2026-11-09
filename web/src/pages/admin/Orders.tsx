import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { motion } from 'motion/react';
import { Bike, Printer, Receipt, ShoppingBag, UtensilsCrossed } from 'lucide-react';
import { Badge, Button, Card, Drawer, Field, Input, QueryBoundary, Select, Tabs, Textarea, useToast, ConfirmButton } from '@/components/ui';
import { api, download, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn, dateTime, money, statusLabel, timeOnly } from '@/lib/format';
import { useSeo } from '@/lib/hooks';
import { useOutletFilter } from '@/lib/outlet';

const COLUMNS = ['NEW', 'ACCEPTED', 'PREPARING', 'READY', 'OUT_FOR_DELIVERY', 'SERVED'] as const;
const NEXT: Record<string, string[]> = {
  NEW: ['ACCEPTED'], ACCEPTED: ['PREPARING'], PREPARING: ['READY'], READY: ['OUT_FOR_DELIVERY', 'SERVED', 'COMPLETED'], OUT_FOR_DELIVERY: ['COMPLETED'], SERVED: ['COMPLETED'],
};
const typeOk = (to: string, type: string, from: string) => (to === 'OUT_FOR_DELIVERY' ? type === 'DELIVERY' : to === 'SERVED' ? type === 'DINE_IN' : from === 'READY' && to === 'COMPLETED' ? type === 'TAKEAWAY' || type === 'PICKUP' : true);
const TypeIcon = ({ t }: { t: string }) => (t === 'DELIVERY' ? <Bike className="h-4 w-4" /> : t === 'DINE_IN' ? <UtensilsCrossed className="h-4 w-4" /> : <ShoppingBag className="h-4 w-4" />);
const payBadge = (o: any) => {
  const paid = o.payments.some((p: any) => ['PAID', 'PARTIALLY_REFUNDED'].includes(p.status));
  const refunded = o.payments.some((p: any) => p.status === 'REFUNDED');
  return refunded ? <Badge tone="neutral">Refunded</Badge> : paid ? <Badge tone="success">Paid</Badge> : o.payments.some((p: any) => p.status === 'PENDING') ? <Badge tone="warn">Payment pending</Badge> : <Badge>Unpaid</Badge>;
};

export default function Orders() {
  useSeo('Orders');
  const [view, setView] = useState<'board' | 'list'>('board');
  const [openId, setOpenId] = useState<string | null>(null);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3"><Tabs value={view} onChange={setView} tabs={[{ id: 'board', label: 'Live board' }, { id: 'list', label: 'All orders' }]} /></div>
      {view === 'board' ? <Board onOpen={setOpenId} /> : <List onOpen={setOpenId} />}
      <OrderDrawer id={openId} onClose={() => setOpenId(null)} />
    </div>
  );
}

function Board({ onOpen }: { onOpen: (id: string) => void }) {
  const qc = useQueryClient(); const toast = useToast(); const { can } = useAuth();
  const { outletId } = useOutletFilter();
  const q = useQuery({ queryKey: ['board', outletId], queryFn: () => api('/api/orders/board', { query: { outletId } }), refetchInterval: 20_000 });
  const move = useMutation({ mutationFn: ({ id, status }: { id: string; status: string }) => api(`/api/orders/${id}/status`, { method: 'PATCH', body: { status } }), onSuccess: () => qc.invalidateQueries({ queryKey: ['board'] }), onError: (e) => toast('error', errorMessage(e)) });
  const [drag, setDrag] = useState<string | null>(null);
  return (
    <QueryBoundary q={q}>
      {(d) => (
        <div className="flex gap-3 overflow-x-auto pb-4">
          {COLUMNS.map((col) => {
            const orders = d.items.filter((o: any) => o.status === col);
            return (
              <section key={col} aria-label={statusLabel(col)} onDragOver={(e) => e.preventDefault()}
                onDrop={() => { const o = d.items.find((x: any) => x.id === drag); if (o && o.status !== col && NEXT[o.status]?.includes(col) && typeOk(col, o.type, o.status)) move.mutate({ id: o.id, status: col }); else if (o) toast('error', `Cannot move a ${statusLabel(o.status).toLowerCase()} order to ${statusLabel(col).toLowerCase()}`); setDrag(null); }}
                className="w-72 shrink-0 rounded-2xl bg-surface-2 p-2">
                <h3 className="flex items-center justify-between px-2 py-1.5 text-sm font-semibold">{statusLabel(col)} <span className="rounded-full bg-surface px-2 text-xs">{orders.length}</span></h3>
                <div className="space-y-2">
                  {orders.length === 0 && <p className="px-2 py-6 text-center text-xs text-muted">Nothing here</p>}
                  {orders.map((o: any) => {
                    const next = (NEXT[o.status] ?? []).filter((n) => typeOk(n, o.type, o.status))[0];
                    return (
                      <motion.div layout key={o.id} draggable onDragStart={() => setDrag(o.id)} className="cursor-grab rounded-xl border border-border bg-surface p-3 shadow-sm active:cursor-grabbing">
                        <button className="block w-full text-left" onClick={() => onOpen(o.id)}>
                          <div className="flex items-center justify-between"><span className="font-semibold">#{o.number}</span><span className="flex items-center gap-1 text-xs text-muted"><TypeIcon t={o.type} />{o.table ? `T${o.table.label}` : statusLabel(o.type)}</span></div>
                          <p className="mt-1 line-clamp-2 text-xs text-muted">{o.items.map((i: any) => `${i.quantity}× ${i.name}`).join(', ')}</p>
                          <div className="mt-2 flex items-center justify-between text-xs"><span>{timeOnly(o.createdAt)}</span>{o.payments ? payBadge(o) : null}<span className="font-medium">{o.payments ? money(o.total) : ''}</span></div>
                        </button>
                        {next && <Button size="sm" className="mt-2 w-full" variant={o.status === 'NEW' ? 'accent' : 'outline'} loading={move.isPending && move.variables?.id === o.id} onClick={() => move.mutate({ id: o.id, status: next })}>{o.status === 'NEW' ? 'Accept' : `Mark ${statusLabel(next).toLowerCase()}`}</Button>}
                        {o.status === 'NEW' && can('orders.manage') && <ConfirmButton size="sm" variant="ghost" className="mt-1 w-full text-danger" message={`Reject order #${o.number}?`} onConfirm={() => move.mutate({ id: o.id, status: 'REJECTED' })}>Reject</ConfirmButton>}
                      </motion.div>);
                  })}
                </div>
              </section>);
          })}
        </div>
      )}
    </QueryBoundary>
  );
}

function List({ onOpen }: { onOpen: (id: string) => void }) {
  const [f, setF] = useState({ q: '', status: '', type: '', page: 1 });
  const { outletId } = useOutletFilter();
  const q = useQuery({ queryKey: ['orders', f, outletId], queryFn: () => api('/api/orders', { query: { ...f, outletId, pageSize: 20 } }), placeholderData: (p) => p });
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <Input aria-label="Search orders" placeholder="Order #, name or phone" className="w-60" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value, page: 1 })} />
        <Select aria-label="Status" className="w-44" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value, page: 1 })}><option value="">All statuses</option>{['NEW', 'ACCEPTED', 'PREPARING', 'READY', 'OUT_FOR_DELIVERY', 'SERVED', 'COMPLETED', 'REJECTED', 'CANCELLED'].map((s) => <option key={s} value={s}>{statusLabel(s)}</option>)}</Select>
        <Select aria-label="Type" className="w-40" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value, page: 1 })}><option value="">All types</option>{['DINE_IN', 'TAKEAWAY', 'PICKUP', 'DELIVERY'].map((s) => <option key={s} value={s}>{statusLabel(s)}</option>)}</Select>
      </div>
      <QueryBoundary q={q} empty={(d) => d.items.length === 0}>
        {(d) => (<>
          <Card className="overflow-x-auto"><table className="w-full text-sm"><thead className="border-b border-border text-left text-xs uppercase text-muted"><tr><th className="p-3">#</th><th>Time</th><th>Customer</th><th>Type</th><th>Status</th><th>Payment</th><th className="pr-3 text-right">Total</th></tr></thead>
            <tbody>{d.items.map((o: any) => (<tr key={o.id} tabIndex={0} onClick={() => onOpen(o.id)} onKeyDown={(e) => e.key === 'Enter' && onOpen(o.id)} className="cursor-pointer border-b border-border/60 last:border-0 hover:bg-surface-2">
              <td className="p-3 font-medium">#{o.number}</td><td>{dateTime(o.createdAt)}</td><td>{o.customer?.name ?? o.guestName ?? '—'}</td><td>{statusLabel(o.type)}</td><td><Badge tone={o.status === 'COMPLETED' ? 'success' : ['CANCELLED', 'REJECTED'].includes(o.status) ? 'danger' : 'warn'}>{statusLabel(o.status)}</Badge></td><td>{payBadge(o)}</td><td className="pr-3 text-right">{money(o.total)}</td></tr>))}</tbody></table></Card>
          <div className="flex items-center justify-between text-sm"><span className="text-muted">{d.total} orders</span><div className="flex gap-2"><Button size="sm" variant="outline" disabled={f.page <= 1} onClick={() => setF({ ...f, page: f.page - 1 })}>Previous</Button><span className="self-center">Page {d.page} / {d.pages}</span><Button size="sm" variant="outline" disabled={f.page >= d.pages} onClick={() => setF({ ...f, page: f.page + 1 })}>Next</Button></div></div></>)}
      </QueryBoundary>
    </div>
  );
}

function OrderDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const qc = useQueryClient(); const toast = useToast(); const { can } = useAuth();
  const q = useQuery({ queryKey: ['order', id], enabled: !!id, queryFn: () => api(`/api/orders/${id}`) });
  const drivers = useQuery({ queryKey: ['drivers'], enabled: !!id && can('orders.manage'), queryFn: () => api('/api/staff/drivers') });
  const refresh = () => { qc.invalidateQueries({ queryKey: ['order', id] }); qc.invalidateQueries({ queryKey: ['orders'] }); qc.invalidateQueries({ queryKey: ['board'] }); };
  const onError = (e: unknown) => toast('error', errorMessage(e));
  const status = useMutation({ mutationFn: (s: string) => api(`/api/orders/${id}/status`, { method: 'PATCH', body: { status: s } }), onSuccess: refresh, onError });
  const patch = useMutation({ mutationFn: (b: any) => api(`/api/orders/${id}`, { method: 'PATCH', body: b }), onSuccess: () => { toast('success', 'Saved'); refresh(); }, onError });
  const takePay = useMutation({ mutationFn: (method: string) => api('/api/payments/create', { body: { orderId: id, method } }), onSuccess: refresh, onError });
  const confirm = useMutation({ mutationFn: (pid: string) => api(`/api/payments/${pid}/confirm-cash`, { body: {} }), onSuccess: () => { toast('success', 'Payment recorded'); refresh(); }, onError });
  const [refundAmt, setRefundAmt] = useState('');
  const [reason, setReason] = useState('');
  const refund = useMutation({ mutationFn: (pid: string) => api('/api/payments/refund', { body: { paymentId: pid, amount: refundAmt ? Number(refundAmt) : undefined, reason: reason || undefined } }), onSuccess: () => { toast('success', 'Refund issued'); setRefundAmt(''); setReason(''); refresh(); }, onError });
  const [kn, setKn] = useState<string | null>(null);

  return (
    <Drawer open={!!id} onClose={onClose} title={q.data ? `Order #${q.data.number}` : 'Order'}>
      <QueryBoundary q={q}>
        {(o) => {
          const next = (NEXT[o.status] ?? []).filter((n) => typeOk(n, o.type, o.status));
          const unpaid = o.payments.every((p: any) => !['PAID', 'PARTIALLY_REFUNDED'].includes(p.status));
          return (
            <div className="space-y-5 text-sm">
              <div className="flex flex-wrap items-center gap-2"><Badge tone={o.status === 'COMPLETED' ? 'success' : ['CANCELLED', 'REJECTED'].includes(o.status) ? 'danger' : 'warn'}>{statusLabel(o.status)}</Badge><Badge>{statusLabel(o.type)}</Badge>{o.table && <Badge>Table {o.table.label}</Badge>}{payBadge(o)}<span className="text-muted">{dateTime(o.createdAt)}</span></div>
              {next.length > 0 && <div className="flex flex-wrap gap-2">{next.map((n) => <Button key={n} loading={status.isPending} onClick={() => status.mutate(n)}>{n === 'ACCEPTED' ? 'Accept' : `Mark ${statusLabel(n).toLowerCase()}`}</Button>)}
                {['NEW', 'ACCEPTED', 'PREPARING', 'READY'].includes(o.status) && (can('orders.manage') || can('kitchen.manage')) && <ConfirmButton variant="danger" message={`${o.status === 'NEW' ? 'Reject' : 'Cancel'} order #${o.number}? Points, vouchers and promo uses are returned to the customer.`} onConfirm={() => status.mutate(o.status === 'NEW' ? 'REJECTED' : 'CANCELLED')}>{o.status === 'NEW' ? 'Reject' : 'Cancel order'}</ConfirmButton>}</div>}

              <section><h3 className="mb-1 font-medium">Customer</h3>{(o.customer || o.guestName) ? <p>{o.customer?.name ?? o.guestName}<br />{o.customer?.phone ?? o.guestPhone}<br />{o.customer?.email ?? o.guestEmail}{o.customer && <span className="block text-muted">{o.customer.tier} · {o.customer.loyaltyPoints} pts</span>}</p> : <p className="text-muted">Walk-in</p>}
                {o.deliveryAddress && <p className="mt-1 whitespace-pre-line">📍 {o.deliveryAddress} {o.deliveryPostal}{o.deliveryNotes && <span className="block text-muted">{o.deliveryNotes}</span>}</p>}
                {o.scheduledFor && <p className="mt-1">⏰ Scheduled for {dateTime(o.scheduledFor)}</p>}</section>

              <section><h3 className="mb-1 font-medium">Items</h3>
                <ul className="divide-y divide-border">{o.items.map((i: any) => <li key={i.id} className="flex justify-between gap-3 py-2"><div><p>{i.quantity} × {i.name}{i.variantName ? ` (${i.variantName})` : ''} <Badge tone={i.status === 'READY' ? 'success' : i.status === 'PREPARING' ? 'warn' : 'neutral'}>{statusLabel(i.status)}</Badge></p>{(i.addons as any[]).length > 0 && <p className="text-xs text-muted">+ {(i.addons as any[]).map((a) => a.name).join(', ')}</p>}{i.notes && <p className="text-xs italic text-warn">“{i.notes}”</p>}</div><span>{money(i.lineTotal)}</span></li>)}</ul>
                <dl className="mt-2 space-y-0.5 border-t border-border pt-2">{[['Subtotal', o.subtotal], ['Discount', -o.discount], ['Service', o.serviceCharge], ['Tax', o.tax], ['Delivery', o.deliveryFee], ['Tip', o.tip]].filter(([, v]) => Number(v) !== 0).map(([k, v]) => <div key={k as string} className="flex justify-between"><dt>{k}</dt><dd>{money(v)}</dd></div>)}<div className="flex justify-between text-base font-semibold"><dt>Total</dt><dd>{money(o.total)}</dd></div></dl>
                {o.notes && <p className="mt-2 rounded-lg bg-accent/10 p-2">Customer note: {o.notes}</p>}</section>

              {can('orders.manage') && <section className="space-y-2"><h3 className="font-medium">Assignment & kitchen</h3>
                {o.type === 'DELIVERY' && <Field label="Delivery driver">{(fid) => <Select id={fid} value={o.driverId ?? ''} onChange={(e) => patch.mutate({ driverId: e.target.value || null })}><option value="">Unassigned</option>{(drivers.data ?? []).map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}</Select>}</Field>}
                <Field label="Kitchen notes">{(fid) => <Textarea id={fid} value={kn ?? o.kitchenNotes ?? ''} onChange={(e) => setKn(e.target.value)} />}</Field>
                {kn !== null && <Button size="sm" onClick={() => patch.mutate({ kitchenNotes: kn })}>Save notes</Button>}</section>}

              {(can('payments.process') || can('payments.refund')) && <section className="space-y-2"><h3 className="font-medium">Payments</h3>
                {o.payments.length === 0 && <p className="text-muted">No payment recorded yet.</p>}
                {o.payments.map((p: any) => (<div key={p.id} className="rounded-xl border border-border p-3"><div className="flex items-center justify-between"><span>{statusLabel(p.method)} · {money(p.amount)}</span><Badge tone={p.status === 'PAID' ? 'success' : p.status === 'FAILED' ? 'danger' : 'warn'}>{statusLabel(p.status)}</Badge></div>
                  {p.status === 'PENDING' && p.method.startsWith('CASH') && can('payments.process') && <Button size="sm" className="mt-2" loading={confirm.isPending} onClick={() => confirm.mutate(p.id)}>Cash received</Button>}
                  {['PAID', 'PARTIALLY_REFUNDED'].includes(p.status) && can('payments.refund') && (<div className="mt-2 flex flex-wrap items-end gap-2"><Input aria-label="Refund amount" type="number" step="0.01" min="0" placeholder="Full" className="w-24" value={refundAmt} onChange={(e) => setRefundAmt(e.target.value)} /><Input aria-label="Reason" placeholder="Reason" className="w-40" value={reason} onChange={(e) => setReason(e.target.value)} /><ConfirmButton size="sm" variant="outline" message={`Refund ${refundAmt ? money(refundAmt) : 'the remaining balance'} to the customer?`} onConfirm={() => refund.mutate(p.id)}>Refund</ConfirmButton></div>)}</div>))}
                {unpaid && o.payments.every((p: any) => p.status !== 'PENDING') && can('payments.process') && !['CANCELLED', 'REJECTED'].includes(o.status) && <Button size="sm" variant="outline" onClick={() => takePay.mutate(o.type === 'DELIVERY' ? 'CASH_ON_DELIVERY' : 'CASH_AT_RESTAURANT')}>Record cash payment</Button>}</section>}

              <section><h3 className="mb-1 font-medium">History</h3><ol className="space-y-1 text-xs text-muted">{o.history.map((h: any) => <li key={h.id}>{statusLabel(h.status)} · {dateTime(h.createdAt)}{h.note && ` — ${h.note}`}</li>)}</ol></section>
              <div className="flex gap-2 no-print"><Button variant="outline" size="sm" onClick={() => download(`/api/orders/${o.id}/receipt.pdf`, `receipt-${o.number}.pdf`).catch((e) => toast('error', errorMessage(e)))}><Receipt className="h-4 w-4" /> Receipt PDF</Button><Button variant="outline" size="sm" onClick={() => window.print()}><Printer className="h-4 w-4" /> Print</Button></div>
            </div>);
        }}
      </QueryBoundary>
    </Drawer>
  );
}
void cn;
