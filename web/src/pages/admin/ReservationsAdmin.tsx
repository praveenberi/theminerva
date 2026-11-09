import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import { Badge, Button, Card, ConfirmButton, EmptyState, Field, Input, Modal, QueryBoundary, Select, Textarea, useToast } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { getTimezone, money, statusLabel, timeOnly, cn } from '@/lib/format';
import { useSeo } from '@/lib/hooks';

const ymd = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: getTimezone() }).format(d);
const shift = (date: string, n: number) => { const d = new Date(date + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const TONE: Record<string, any> = { PENDING: 'warn', CONFIRMED: 'success', SEATED: 'brand', COMPLETED: 'neutral', CANCELLED: 'danger', NO_SHOW: 'danger' };

export default function ReservationsAdmin() {
  useSeo('Reservations');
  const qc = useQueryClient(); const toast = useToast();
  const [date, setDate] = useState(ymd(new Date()));
  const [create, setCreate] = useState<any>(null);
  const range = { from: new Date(`${shift(date, -1)}T00:00:00Z`).toISOString(), to: new Date(`${shift(date, 2)}T00:00:00Z`).toISOString() };
  const q = useQuery({ queryKey: ['reservations', date], queryFn: () => api('/api/reservations', { query: range }), refetchInterval: 30_000 });
  const pending = useQuery({ queryKey: ['reservations', 'pending'], queryFn: () => api('/api/reservations', { query: { status: 'PENDING' } }) });
  const wait = useQuery({ queryKey: ['waitlist'], queryFn: () => api('/api/reservations/waitlist/all') });
  const refresh = () => { qc.invalidateQueries({ queryKey: ['reservations'] }); qc.invalidateQueries({ queryKey: ['tables'] }); };
  const upd = useMutation({ mutationFn: ({ id, ...b }: any) => api(`/api/reservations/${id}`, { method: 'PUT', body: b }), onSuccess: refresh, onError: (e) => toast('error', errorMessage(e)) });
  const rmWait = useMutation({ mutationFn: (id: string) => api(`/api/reservations/waitlist/${id}`, { method: 'DELETE' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['waitlist'] }) });
  const [resched, setResched] = useState<any>(null);

  const onDay = (q.data ?? []).filter((r: any) => ymd(new Date(r.startAt)) === date);
  const days = [-1, 0, 1].map((n) => shift(date, n));

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
      <section className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="icon" aria-label="Previous day" onClick={() => setDate(shift(date, -1))}><ChevronLeft className="h-4 w-4" /></Button>
          <Input type="date" aria-label="Date" className="w-44" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />
          <Button variant="outline" size="icon" aria-label="Next day" onClick={() => setDate(shift(date, 1))}><ChevronRight className="h-4 w-4" /></Button>
          <Button variant="outline" onClick={() => setDate(ymd(new Date()))}>Today</Button>
          <Button className="ml-auto" onClick={() => setCreate({ date, time: '19:00', guests: 2, name: '', phone: '', kind: 'TABLE' })}><Plus className="h-4 w-4" /> New booking</Button>
        </div>
        <div className="grid grid-cols-3 gap-2 text-center text-sm">{days.map((d) => { const n = (q.data ?? []).filter((r: any) => ymd(new Date(r.startAt)) === d && !['CANCELLED', 'NO_SHOW'].includes(r.status)); return <button key={d} onClick={() => setDate(d)} className={cn('rounded-xl border p-2', d === date ? 'border-brand bg-brand text-brand-fg' : 'border-border')}>{d}<br /><span className="text-xs opacity-80">{n.length} bookings · {n.reduce((a: number, r: any) => a + r.guests, 0)} guests</span></button>; })}</div>
        <QueryBoundary q={q}>
          {() => onDay.length === 0 ? <EmptyState title="No reservations on this day" /> : (
            <ul className="space-y-3">{onDay.map((r: any) => (
              <Card key={r.id} className="space-y-2 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2"><div><p className="font-medium">{timeOnly(r.startAt)} · {r.name} <span className="text-muted">({r.guests})</span></p><p className="text-sm text-muted">{r.phone}{r.email && ` · ${r.email}`} · {r.table ? `Table ${r.table.label}` : statusLabel(r.kind)} · <span className="font-mono">{r.reference}</span></p></div><Badge tone={TONE[r.status]}>{statusLabel(r.status)}</Badge></div>
                {r.notes && <p className="rounded-lg bg-accent/10 p-2 text-sm">{r.notes}</p>}
                {Number(r.depositAmount) > 0 && <p className="text-sm">Deposit {money(r.depositAmount)} — {r.depositPaid ? 'paid' : 'unpaid'} {!r.depositPaid && <button className="underline" onClick={() => upd.mutate({ id: r.id, depositPaid: true, status: 'CONFIRMED' })}>mark paid</button>}</p>}
                <div className="flex flex-wrap gap-2">
                  {r.status === 'PENDING' && <Button size="sm" onClick={() => upd.mutate({ id: r.id, status: 'CONFIRMED' })}>Confirm</Button>}
                  {r.status === 'CONFIRMED' && <Button size="sm" onClick={() => upd.mutate({ id: r.id, status: 'SEATED' })}>Seat</Button>}
                  {r.status === 'SEATED' && <Button size="sm" onClick={() => upd.mutate({ id: r.id, status: 'COMPLETED' })}>Complete</Button>}
                  {['PENDING', 'CONFIRMED'].includes(r.status) && <><Button size="sm" variant="outline" onClick={() => setResched(r)}>Reschedule</Button><Button size="sm" variant="outline" onClick={() => upd.mutate({ id: r.id, status: 'NO_SHOW' })}>No-show</Button><ConfirmButton size="sm" variant="ghost" className="text-danger" message={`Cancel the booking for ${r.name}? They will be notified.`} onConfirm={() => upd.mutate({ id: r.id, status: 'CANCELLED' })}>Cancel</ConfirmButton></>}
                </div>
              </Card>))}</ul>)}
        </QueryBoundary>
      </section>
      <aside className="space-y-4">
        <Card className="p-4"><h3 className="mb-2 text-lg">Awaiting confirmation</h3><QueryBoundary q={pending}>{(d) => d.length === 0 ? <p className="text-sm text-muted">Nothing pending.</p> : <ul className="space-y-2 text-sm">{d.map((r: any) => <li key={r.id} className="flex items-center justify-between gap-2"><span>{r.name} · {r.guests} · {new Date(r.startAt).toLocaleDateString()}<br /><span className="text-xs text-muted">{statusLabel(r.kind)}</span></span><Button size="sm" onClick={() => upd.mutate({ id: r.id, status: 'CONFIRMED' })}>Confirm</Button></li>)}</ul>}</QueryBoundary></Card>
        <Card className="p-4"><h3 className="mb-2 text-lg">Waitlist</h3><QueryBoundary q={wait}>{(d) => d.length === 0 ? <p className="text-sm text-muted">Empty.</p> : <ul className="space-y-2 text-sm">{d.map((w: any) => <li key={w.id} className="flex items-center justify-between"><span>{w.name} ({w.guests})<br /><a className="text-xs underline" href={`tel:${w.phone}`}>{w.phone}</a></span><Button size="sm" variant="ghost" onClick={() => rmWait.mutate(w.id)}>Seated</Button></li>)}</ul>}</QueryBoundary></Card>
      </aside>

      <Modal open={!!create} onClose={() => setCreate(null)} title="New booking">
        {create && <BookingForm v={create} onChange={setCreate} onDone={() => { setCreate(null); refresh(); toast('success', 'Booking created'); }} />}
      </Modal>
      <Modal open={!!resched} onClose={() => setResched(null)} title="Reschedule">
        {resched && <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); upd.mutate({ id: resched.id, date: resched.d, time: resched.t }, { onSuccess: () => { setResched(null); toast('success', 'Rescheduled'); } }); }}>
          <div className="grid grid-cols-2 gap-4"><Field label="Date">{(id) => <Input id={id} type="date" required value={resched.d ?? ymd(new Date(resched.startAt))} onChange={(e) => setResched({ ...resched, d: e.target.value })} />}</Field><Field label="Time">{(id) => <Input id={id} type="time" required value={resched.t ?? timeOnly(resched.startAt).slice(0, 5)} onChange={(e) => setResched({ ...resched, t: e.target.value })} />}</Field></div>
          <div className="flex justify-end"><Button loading={upd.isPending} disabled={!resched.d && !resched.t}>Move booking</Button></div></form>}
      </Modal>
    </div>
  );
}

function BookingForm({ v, onChange, onDone }: { v: any; onChange: (v: any) => void; onDone: () => void }) {
  const toast = useToast();
  const m = useMutation({ mutationFn: () => api('/api/reservations', { body: { kind: v.kind, date: v.date, time: v.time, guests: Number(v.guests), name: v.name, phone: v.phone, email: v.email || undefined, notes: v.notes || undefined } }), onSuccess: onDone, onError: (e) => toast('error', errorMessage(e)) });
  const set = (k: string, val: any) => onChange({ ...v, [k]: val });
  return (
    <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
      <div className="grid grid-cols-3 gap-3"><Field label="Date">{(id) => <Input id={id} type="date" required value={v.date} onChange={(e) => set('date', e.target.value)} />}</Field><Field label="Time">{(id) => <Input id={id} type="time" required value={v.time} onChange={(e) => set('time', e.target.value)} />}</Field><Field label="Guests">{(id) => <Input id={id} type="number" min={1} required value={v.guests} onChange={(e) => set('guests', e.target.value)} />}</Field></div>
      <Field label="Type">{(id) => <Select id={id} value={v.kind} onChange={(e) => set('kind', e.target.value)}><option value="TABLE">Table</option><option value="EVENT">Event</option><option value="PRIVATE_DINING">Private dining</option></Select>}</Field>
      <div className="grid grid-cols-2 gap-3"><Field label="Name">{(id) => <Input id={id} required minLength={2} value={v.name} onChange={(e) => set('name', e.target.value)} />}</Field><Field label="Phone">{(id) => <Input id={id} type="tel" required value={v.phone} onChange={(e) => set('phone', e.target.value)} />}</Field></div>
      <Field label="Notes">{(id) => <Textarea id={id} value={v.notes ?? ''} onChange={(e) => set('notes', e.target.value)} />}</Field>
      <div className="flex justify-end"><Button loading={m.isPending}>Create booking</Button></div>
    </form>
  );
}
