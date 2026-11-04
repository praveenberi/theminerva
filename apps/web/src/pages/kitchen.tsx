import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import { Bell, BellOff, Check, Maximize2, Minimize2 } from 'lucide-react';
import { api, errMsg } from '../lib';
import { Skeleton, useToast } from '../ui';

interface Item { id: string; name: string; quantity: number; options: string[]; notes: string | null; done: boolean }
interface Ticket { id: string; number: number; type: string; status: string; table: string | null; customerName: string; notes: string | null; createdAt: string; targetMinutes: number; items: Item[] }

const ACTION: Record<string, { label: string; to: string }> = {
  NEW: { label: 'Accept', to: 'ACCEPTED' }, ACCEPTED: { label: 'Start cooking', to: 'PREPARING' }, PREPARING: { label: 'Order ready', to: 'READY' },
};

function beep() {
  try {
    const ctx = new AudioContext(); const o = ctx.createOscillator(); const g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination); o.frequency.value = 880; g.gain.value = 0.15;
    o.start(); o.stop(ctx.currentTime + 0.25); o.onended = () => ctx.close();
  } catch { /* audio unavailable */ }
}

const mmss = (ms: number) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

export function KitchenPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const wrap = useRef<HTMLDivElement>(null);
  const [full, setFull] = useState(false);
  const [sound, setSound] = useState(false);
  const [, tick] = useState(0);
  const skew = useRef(0); // server clock minus client clock, so timers are right even if this device's clock is off
  const seen = useRef<Set<string> | null>(null);

  const feed = useQuery({ queryKey: ['kds'], queryFn: () => api<{ now: string; orders: Ticket[] }>('/kds'), refetchInterval: 4000 });
  const stats = useQuery({ queryKey: ['kds-stats'], queryFn: () => api<any>(`/kds/stats?tzOffset=${new Date().getTimezoneOffset()}`), refetchInterval: 30000 });

  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 1000); return () => clearInterval(t); }, []);
  useEffect(() => { const f = () => setFull(!!document.fullscreenElement); document.addEventListener('fullscreenchange', f); return () => document.removeEventListener('fullscreenchange', f); }, []);
  useEffect(() => {
    if (!feed.data) return;
    skew.current = new Date(feed.data.now).getTime() - Date.now();
    const ids = new Set(feed.data.orders.map((o) => o.id));
    if (seen.current && sound && feed.data.orders.some((o) => o.status === 'NEW' && !seen.current!.has(o.id))) beep();
    seen.current = ids;
  }, [feed.data, sound]);

  const move = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) => api(`/orders/${id}/status`, { method: 'PATCH', body: { status } }),
    onSettled: () => { qc.invalidateQueries({ queryKey: ['kds'] }); qc.invalidateQueries({ queryKey: ['kds-stats'] }); },
    onError: (e) => toast(errMsg(e), 'err'),
  });
  const toggle = useMutation({
    mutationFn: ({ id, itemId, done }: { id: string; itemId: string; done: boolean }) => api(`/orders/${id}/items/${itemId}`, { method: 'PATCH', body: { done } }),
    onMutate: async ({ id, itemId, done }) => { // optimistic tick so the screen feels instant
      await qc.cancelQueries({ queryKey: ['kds'] });
      qc.setQueryData<any>(['kds'], (d: any) => d && { ...d, orders: d.orders.map((o: Ticket) => o.id === id ? { ...o, items: o.items.map((i) => i.id === itemId ? { ...i, done } : i) } : o) });
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['kds'] }),
    onError: (e) => toast(errMsg(e), 'err'),
  });

  const goFull = () => (document.fullscreenElement ? document.exitFullscreen() : wrap.current?.requestFullscreen());
  const now = Date.now() + skew.current;
  const orders = feed.data?.orders ?? [];
  const late = orders.filter((o) => o.status !== 'READY' && now - new Date(o.createdAt).getTime() > o.targetMinutes * 60_000).length;

  return (
    <div ref={wrap} className={`overflow-auto bg-stone-900 p-4 text-white ${full ? 'h-screen' : 'min-h-[80vh] rounded-2xl'}`}>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="mr-auto text-2xl font-extrabold">Kitchen</h1>
        <span className="rounded-lg bg-white/10 px-3 py-1.5 text-sm">In progress <b>{orders.filter((o) => o.status !== 'READY').length}</b></span>
        <span className={`rounded-lg px-3 py-1.5 text-sm ${late ? 'bg-red-600' : 'bg-white/10'}`}>Late <b>{late}</b></span>
        <span className="rounded-lg bg-white/10 px-3 py-1.5 text-sm">Done today <b>{stats.data?.readyToday ?? '–'}</b></span>
        <span className="rounded-lg bg-white/10 px-3 py-1.5 text-sm">Avg prep <b>{stats.data?.avgPrepMinutes != null ? `${stats.data.avgPrepMinutes} min` : '–'}</b></span>
        <button className="rounded-lg bg-white/10 p-2 hover:bg-white/20" onClick={() => { setSound(!sound); if (!sound) beep(); }} aria-pressed={sound} aria-label={sound ? 'Mute new-order sound' : 'Play sound for new orders'}>{sound ? <Bell size={18} /> : <BellOff size={18} />}</button>
        <button className="rounded-lg bg-white/10 p-2 hover:bg-white/20" onClick={goFull} aria-label={full ? 'Exit full screen' : 'Full screen'}>{full ? <Minimize2 size={18} /> : <Maximize2 size={18} />}</button>
      </div>

      {feed.isLoading ? <Skeleton className="h-64 bg-white/10" /> : feed.error ? <p className="text-red-300" role="alert">{errMsg(feed.error)}</p> : orders.length === 0 ? (
        <p className="py-24 text-center text-xl text-white/50">No orders in the kitchen. New orders appear here automatically.</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <AnimatePresence>
            {orders.map((o) => {
              const elapsed = now - new Date(o.createdAt).getTime();
              const ratio = elapsed / (o.targetMinutes * 60_000);
              const ready = o.status === 'READY';
              const tone = ready ? 'border-sky-400' : ratio >= 1 ? 'border-red-500' : ratio >= 0.7 ? 'border-amber-400' : 'border-emerald-500';
              const act = ACTION[o.status];
              const doneCount = o.items.filter((i) => i.done).length;
              const cooking = o.status === 'ACCEPTED' || o.status === 'PREPARING';
              return (
                <motion.div layout key={o.id} initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.95 }}
                  className={`flex flex-col rounded-2xl border-2 bg-stone-800 p-4 ${tone}`}>
                  <div className="flex items-start justify-between">
                    <div><p className="text-3xl font-extrabold">#{o.number}</p>
                      <p className="text-sm text-white/70">{o.type.replace('_', ' ')}{o.table ? ` · Table ${o.table}` : ''} · {o.customerName}</p></div>
                    <div className="text-right"><p className={`text-2xl font-bold tabular-nums ${!ready && ratio >= 1 ? 'animate-pulse text-red-400' : ''}`}>{mmss(elapsed)}</p>
                      <p className="text-xs text-white/50">target {o.targetMinutes} min</p>{!ready && ratio >= 1 && <p className="text-xs font-bold text-red-400">LATE</p>}</div>
                  </div>
                  {o.notes && <p className="mt-2 rounded-lg bg-amber-400/20 p-2 text-sm text-amber-200">⚠ {o.notes}</p>}
                  <ul className="my-3 flex-1 space-y-1.5">
                    {o.items.map((i) => (
                      <li key={i.id}>
                        <label className={`flex items-start gap-3 rounded-lg p-1.5 ${cooking ? 'cursor-pointer hover:bg-white/5' : ''}`}>
                          <input type="checkbox" className="mt-1 h-5 w-5 accent-emerald-500" checked={i.done || ready} disabled={!cooking}
                            onChange={(e) => toggle.mutate({ id: o.id, itemId: i.id, done: e.target.checked })} aria-label={`${i.name} done`} />
                          <span className={i.done || ready ? 'text-white/40 line-through' : ''}><b>{i.quantity}×</b> {i.name}
                            {i.options.length > 0 && <span className="block text-xs text-white/60">{i.options.join(', ')}</span>}
                            {i.notes && <span className="block text-xs italic text-amber-300">“{i.notes}”</span>}</span>
                        </label>
                      </li>
                    ))}
                  </ul>
                  {ready ? <p className="flex items-center justify-center gap-2 rounded-xl bg-sky-500/20 py-3 font-semibold text-sky-200"><Check size={18} /> Ready for {o.type === 'DELIVERY' ? 'rider pickup' : o.type === 'DINE_IN' ? 'service' : 'collection'}</p> : act && (
                    <button className="rounded-xl bg-emerald-600 py-3 text-lg font-bold hover:bg-emerald-500 disabled:opacity-50" disabled={move.isPending}
                      onClick={() => {
                        if (act.to === 'READY' && doneCount < o.items.length && !confirm(`${o.items.length - doneCount} item(s) not ticked. Mark order ready anyway?`)) return;
                        move.mutate({ id: o.id, status: act.to });
                      }}>{act.label}{cooking && ` · ${doneCount}/${o.items.length}`}</button>
                  )}
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}
