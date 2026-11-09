import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import { AlertTriangle, Maximize2, Minimize2, Volume2, VolumeX } from 'lucide-react';
import { Button, ErrorState, Skeleton, useToast } from '@/components/ui';
import { beep, soundOn } from '@/components/AdminLayout';
import { api, errorMessage } from '@/lib/api';
import { useRealtime } from '@/lib/ws';
import { cn, statusLabel } from '@/lib/format';
import { useSeo } from '@/lib/hooks';
import { useOutletFilter } from '@/lib/outlet';

const fmt = (ms: number) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

export default function Kitchen() {
  useSeo('Kitchen display');
  const qc = useQueryClient(); const toast = useToast();
  const [sp, setSp] = useSearchParams();
  const fs = sp.has('fs');
  const [sound, setSound] = useState(soundOn());
  const [skew, setSkew] = useState(0);
  const [now, setNow] = useState(Date.now());
  const { outletId } = useOutletFilter();
  const q = useQuery({ queryKey: ['board', outletId], queryFn: async () => { const d = await api('/api/orders/board', { query: { outletId } }); setSkew(new Date(d.serverTime).getTime() - Date.now()); return d; }, refetchInterval: 10_000 });
  const stats = useQuery({ queryKey: ['kds-stats'], refetchInterval: 120_000, queryFn: () => api('/api/orders', { query: { status: 'READY,SERVED,COMPLETED', from: new Date(Date.now() - 12 * 3600e3).toISOString(), pageSize: 100 } }) });
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api('/api/restaurant/settings'), retry: false });
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  useRealtime((type) => { if (type === 'order.new' && sound) beep(); }, { staff: true });
  useEffect(() => { try { localStorage.setItem('minerva-sound', sound ? 'on' : 'off'); } catch { /* ignore */ } }, [sound]);

  const move = useMutation({ mutationFn: ({ id, status }: { id: string; status: string }) => api(`/api/orders/${id}/status`, { method: 'PATCH', body: { status } }), onSuccess: () => qc.invalidateQueries({ queryKey: ['board'] }), onError: (e) => toast('error', errorMessage(e)) });
  const item = useMutation({ mutationFn: ({ oid, iid, status }: { oid: string; iid: string; status: string }) => api(`/api/orders/${oid}/items/${iid}`, { method: 'PATCH', body: { status } }), onSuccess: () => qc.invalidateQueries({ queryKey: ['board'] }), onError: (e) => toast('error', errorMessage(e)) });

  const late = settings.data?.kds?.lateAfterMinutes ?? 5;
  const orders: any[] = (q.data?.items ?? []).filter((o: any) => ['NEW', 'ACCEPTED', 'PREPARING', 'READY'].includes(o.status));
  const cols = useMemo(() => [
    ['New', orders.filter((o) => o.status === 'NEW')], ['Accepted', orders.filter((o) => o.status === 'ACCEPTED')],
    ['Preparing', orders.filter((o) => o.status === 'PREPARING')], ['Ready', orders.filter((o) => o.status === 'READY')],
  ] as const, [orders]);

  const avg = useMemo(() => {
    const t = (stats.data?.items ?? []).map((o: any) => { const a = o.history.find((h: any) => h.status === 'ACCEPTED'), r = o.history.find((h: any) => h.status === 'READY'); return a && r ? (new Date(r.createdAt).getTime() - new Date(a.createdAt).getTime()) / 60000 : null; }).filter((x: number | null): x is number => x !== null);
    return t.length ? { avg: t.reduce((a: number, b: number) => a + b, 0) / t.length, n: t.length } : null;
  }, [stats.data]);

  const toggleFs = () => { const n = new URLSearchParams(sp); fs ? n.delete('fs') : n.set('fs', '1'); setSp(n); if (!fs) document.documentElement.requestFullscreen?.().catch(() => {}); else document.exitFullscreen?.().catch(() => {}); };

  return (
    <div className={cn('space-y-4', fs && 'min-h-screen p-4')}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><h2 className="text-3xl">Kitchen</h2><p className="text-sm text-muted">{orders.length} active · late after {late} min over estimate{avg ? ` · avg prep today ${avg.avg.toFixed(1)} min (${avg.n} orders)` : ''}</p></div>
        <div className="flex gap-2">
          <Button variant="outline" size="lg" onClick={() => setSound((s) => !s)} aria-pressed={sound}>{sound ? <Volume2 className="h-5 w-5" /> : <VolumeX className="h-5 w-5" />} Sound {sound ? 'on' : 'off'}</Button>
          <Button variant="outline" size="lg" onClick={toggleFs}>{fs ? <Minimize2 className="h-5 w-5" /> : <Maximize2 className="h-5 w-5" />} {fs ? 'Exit' : 'Full screen'}</Button>
          {fs && <Link to="/admin/orders"><Button variant="ghost" size="lg">Orders</Button></Link>}
        </div>
      </div>
      {q.isLoading ? <div className="grid gap-4 md:grid-cols-4">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-64" />)}</div> : q.error ? <ErrorState error={q.error} retry={() => q.refetch()} /> : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {cols.map(([title, list]) => (
            <section key={title} aria-label={title} className="rounded-2xl bg-surface-2 p-3">
              <h3 className="mb-3 flex items-center justify-between text-xl font-semibold">{title}<span className="rounded-full bg-surface px-3 py-0.5 text-base">{list.length}</span></h3>
              <div className="space-y-3">
                <AnimatePresence>
                  {list.length === 0 && <p className="py-8 text-center text-muted">—</p>}
                  {list.map((o: any) => {
                    const start = new Date(o.history.find((h: any) => h.status === 'ACCEPTED')?.createdAt ?? o.createdAt).getTime();
                    const elapsed = now + skew - start;
                    const isLate = o.status !== 'READY' && o.status !== 'NEW' && elapsed > (o.prepMinutes + late) * 60000;
                    const urgent = o.status !== 'READY' && elapsed > o.prepMinutes * 60000 * 0.8;
                    const waiting = o.status === 'NEW' ? now + skew - new Date(o.createdAt).getTime() : 0;
                    return (
                      <motion.article layout key={o.id} initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.9 }}
                        className={cn('rounded-2xl border-2 bg-surface p-4 shadow-card', isLate ? 'border-danger' : urgent ? 'border-warn' : 'border-transparent')}>
                        <div className="flex items-start justify-between gap-2">
                          <div><p className="font-display text-3xl">#{o.number}</p><p className="text-sm text-muted">{o.table ? `Table ${o.table.label}` : statusLabel(o.type)}{o.scheduledFor && ` · for ${new Date(o.scheduledFor).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`}</p></div>
                          <div className="text-right"><p className={cn('font-mono text-3xl tabular-nums', isLate && 'text-danger')}>{o.status === 'NEW' ? fmt(waiting) : fmt(elapsed)}</p>{isLate && <p className="flex items-center justify-end gap-1 text-sm font-semibold text-danger"><AlertTriangle className="h-4 w-4" /> LATE</p>}<p className="text-xs text-muted">est. {o.prepMinutes} min</p></div>
                        </div>
                        <ul className="my-3 space-y-2">
                          {o.items.map((i: any) => (
                            <li key={i.id}>
                              <button disabled={o.status === 'NEW' || o.status === 'READY'} onClick={() => item.mutate({ oid: o.id, iid: i.id, status: i.status === 'READY' ? 'PREPARING' : 'READY' })}
                                className={cn('flex w-full items-start gap-3 rounded-xl p-2 text-left text-xl leading-tight disabled:cursor-default', i.status === 'READY' ? 'bg-success/15 line-through opacity-70' : 'hover:bg-surface-2')}>
                                <span className="font-bold tabular-nums">{i.quantity}×</span>
                                <span><span className="font-medium">{i.name}</span>{i.variantName && <span className="text-muted"> ({i.variantName})</span>}
                                  {(i.addons as any[]).length > 0 && <span className="block text-base text-muted">+ {(i.addons as any[]).map((a) => a.name).join(', ')}</span>}
                                  {i.notes && <span className="block text-base font-semibold text-warn">⚠ {i.notes}</span>}</span>
                              </button>
                            </li>))}
                        </ul>
                        {o.notes && <p className="mb-2 rounded-lg bg-warn/15 p-2 text-base font-medium">Note: {o.notes}</p>}
                        {o.kitchenNotes && <p className="mb-2 rounded-lg bg-surface-2 p-2 text-base">Kitchen: {o.kitchenNotes}</p>}
                        {o.status === 'NEW' && <Button size="lg" variant="accent" className="h-14 w-full text-lg" onClick={() => move.mutate({ id: o.id, status: 'ACCEPTED' })}>Accept</Button>}
                        {o.status === 'ACCEPTED' && <Button size="lg" className="h-14 w-full text-lg" onClick={() => move.mutate({ id: o.id, status: 'PREPARING' })}>Start preparing</Button>}
                        {o.status === 'PREPARING' && <Button size="lg" className="h-14 w-full bg-success text-lg" onClick={() => move.mutate({ id: o.id, status: 'READY' })}>Mark ready</Button>}
                        {o.status === 'READY' && <p className="rounded-xl bg-success/15 p-3 text-center text-lg font-semibold text-success">Ready for {o.type === 'DELIVERY' ? 'driver' : o.type === 'DINE_IN' ? 'service' : 'pickup'}</p>}
                      </motion.article>);
                  })}
                </AnimatePresence>
              </div>
            </section>))}
        </div>
      )}
    </div>
  );
}
