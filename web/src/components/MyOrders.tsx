import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import { useRealtime } from '@/lib/ws';
import { ClipboardList } from 'lucide-react';
import { Badge, Drawer } from '@/components/ui';
import { api } from '@/lib/api';
import { clearContact, myOrders, type MyOrder } from '@/lib/myorders';
import { dateTime, money, statusLabel } from '@/lib/format';

const DONE = ['COMPLETED', 'CANCELLED', 'REJECTED'];

function useMine() {
  const [list, setList] = useState<MyOrder[]>(myOrders);
  useEffect(() => { const h = () => setList(myOrders()); window.addEventListener('minerva-orders', h); window.addEventListener('storage', h); return () => { window.removeEventListener('minerva-orders', h); window.removeEventListener('storage', h); }; }, []);
  const qc = useQueryClient();
  useRealtime(() => qc.invalidateQueries({ queryKey: ['track'] }), { track: list.map((o) => o.token) });
  const results = useQueries({
    queries: list.map((o) => ({ queryKey: ['track', o.token], queryFn: () => api(`/api/public/orders/${o.token}`), refetchInterval: 15_000, retry: false })),
  });
  const rows = list.map((o, i) => ({ ...o, data: results[i]?.data as any, failed: !!results[i]?.error }));
  const active = rows.filter((r) => r.data && !DONE.includes(r.data.status)).length;
  // every order from this device has finished and been loaded: forget the saved name / phone so the next visit starts clean
  const settled = rows.length > 0 && rows.every((r) => r.data || r.failed) && active === 0 && rows.some((r) => r.data?.status === 'COMPLETED');
  useEffect(() => { if (settled) clearContact(); }, [settled]);
  return { rows, active, count: list.length };
}

export function MyOrdersButton({ onClick }: { onClick: () => void }) {
  const { active, count } = useMine();
  if (!count) return null;
  return (
    <button className="relative rounded-lg p-2 hover:bg-surface-2" aria-label={`My orders${active ? `, ${active} in progress` : ''}`} onClick={onClick}>
      <ClipboardList className="h-5 w-5" />
      {active > 0 && <span className="absolute -right-0.5 -top-0.5 grid h-5 min-w-5 place-items-center rounded-full bg-success px-1 text-xs font-semibold text-white">{active}</span>}
    </button>
  );
}

export function MyOrdersDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { rows } = useMine();
  return (
    <Drawer open={open} onClose={onClose} title="My orders">
      {rows.length === 0 ? <p className="py-10 text-center text-sm text-muted">Orders you place from this device in the last 24 hours show up here.</p> : (
        <ul className="space-y-3">
          {rows.map((r) => (
            <li key={r.token} className="rounded-2xl border border-border p-3 text-sm">
              {r.failed ? <p className="text-muted">Order #{r.number} is no longer available.</p> : !r.data ? <p className="text-muted">Loading order #{r.number}…</p> : (
                <>
                  <div className="flex items-center justify-between"><p className="font-medium">Order #{r.data.number}{r.data.group?.tableLabel ? ` · Table ${r.data.group.tableLabel}` : ''}</p><Badge tone={r.data.status === 'COMPLETED' ? 'success' : ['CANCELLED', 'REJECTED'].includes(r.data.status) ? 'danger' : 'warn'}>{statusLabel(r.data.status)}</Badge></div>
                  <p className="mt-1 text-muted">{r.data.items.map((i: any) => `${i.quantity}× ${i.name}`).join(', ')}</p>
                  <div className="mt-2 flex items-center justify-between"><span className="text-xs text-muted">{dateTime(r.data.createdAt)} · {money(r.data.total)}</span>
                    <Link to={`/track/${r.token}`} onClick={onClose} className="font-medium underline">{r.data.group ? 'View table orders' : 'Track'}</Link></div>
                </>)}
            </li>))}
        </ul>)}
    </Drawer>
  );
}
