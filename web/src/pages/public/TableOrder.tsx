import { useEffect } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BellRing, Receipt } from 'lucide-react';
import { Button, ErrorState, useToast } from '@/components/ui';
import Menu from '@/pages/public/Menu';
import { api, errorMessage } from '@/lib/api';
import { useRealtime } from '@/lib/ws';
import { useCart } from '@/lib/cart';
import { money, statusLabel } from '@/lib/format';

/** Landing page for a table QR code: the menu shows immediately; table details load alongside it. */
export default function TableOrder() {
  const { token } = useParams();
  const { dispatch, state } = useCart();
  const toast = useToast();
  const q = useQuery({ queryKey: ['table', token], queryFn: () => api(`/api/public/table/${token}`), refetchInterval: 20_000, retry: false });
  // bind the cart to this table straight away (label fills in once known)
  useEffect(() => { dispatch({ t: 'table', token, label: q.data?.table.label ?? state.tableLabel }); }, [token, q.data?.table.label]); // eslint-disable-line
  const call = useMutation({ mutationFn: () => api(`/api/tables/by-token/${token}/call-waiter`, { body: {} }), onSuccess: () => toast('success', 'A team member is on the way'), onError: (e) => toast('error', errorMessage(e)) });
  const bill = useMutation({ mutationFn: () => api(`/api/tables/by-token/${token}/request-bill`, { body: {} }), onSuccess: () => toast('success', 'Bill requested — we’ll bring it over'), onError: (e) => toast('error', errorMessage(e)) });

  const s = q.data?.session;
  const qc = useQueryClient();
  useRealtime(() => qc.invalidateQueries({ queryKey: ['table', token] }), { track: (s?.orders ?? []).map((o: any) => o.trackingToken) });

  if (q.error) return <div className="mx-auto max-w-xl space-y-3 p-8"><ErrorState error={new Error('This QR code is not valid. Please ask a team member for help.')} /><Link to="/menu" className="underline">View the menu</Link></div>;
  return (
    <>
      <div className="sticky top-16 z-30 border-b border-border bg-surface/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-2">
          <p className="font-display text-lg">Table {q.data?.table.label ?? '…'}</p>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => call.mutate()} loading={call.isPending} disabled={!q.data}><BellRing className="h-4 w-4" /> Call waiter</Button>
            <Button size="sm" variant="outline" onClick={() => bill.mutate()} loading={bill.isPending} disabled={!s}><Receipt className="h-4 w-4" /> Bill</Button>
          </div>
        </div>
        {s?.orders.length > 0 && (
          <ul className="mx-auto max-w-6xl space-y-1 border-t border-border px-4 py-2 text-xs">
            {s.orders.map((o: any) => <li key={o.number} className="flex justify-between"><Link to={`/track/${o.trackingToken}`} className="underline">#{o.number} · {o.items.map((i: any) => `${i.quantity}× ${i.name}`).join(', ')}</Link><span>{statusLabel(o.status)} · {money(o.total)}</span></li>)}
          </ul>
        )}
      </div>
      <Menu forcedMode="DINE_IN" />
    </>
  );
}
