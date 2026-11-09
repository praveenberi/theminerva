import { useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { motion } from 'motion/react';
import { Check, CircleDot } from 'lucide-react';
import { Badge, Card, ErrorState, Skeleton } from '@/components/ui';
import { api } from '@/lib/api';
import { useRealtime } from '@/lib/ws';
import { useSeo } from '@/lib/hooks';
import { cn, dateTime, money, statusLabel } from '@/lib/format';

const FLOW: Record<string, string[]> = {
  DINE_IN: ['NEW', 'ACCEPTED', 'PREPARING', 'READY', 'SERVED', 'COMPLETED'],
  TAKEAWAY: ['NEW', 'ACCEPTED', 'PREPARING', 'READY', 'COMPLETED'],
  PICKUP: ['NEW', 'ACCEPTED', 'PREPARING', 'READY', 'COMPLETED'],
  DELIVERY: ['NEW', 'ACCEPTED', 'PREPARING', 'READY', 'OUT_FOR_DELIVERY', 'COMPLETED'],
};
const LABEL: Record<string, string> = { NEW: 'Order received', ACCEPTED: 'Accepted', PREPARING: 'Being prepared', READY: 'Ready', OUT_FOR_DELIVERY: 'On its way', SERVED: 'Served', COMPLETED: 'Completed' };

type Timeline = { type: string; status: string; history: any[]; prepMinutes: number; driverName?: string };

function Steps({ o }: { o: Timeline }) {
  const steps = FLOW[o.type] ?? FLOW.TAKEAWAY;
  const idx = steps.indexOf(o.status);
  return (
    <ol className="relative space-y-4">
      {steps.map((s, i) => {
        const done = i < idx || o.status === 'COMPLETED', current = i === idx && o.status !== 'COMPLETED';
        const at = o.history.find((h: any) => h.status === s)?.at;
        return (
          <li key={s} className="flex items-start gap-3">
            <motion.span animate={current ? { scale: [1, 1.15, 1] } : {}} transition={{ repeat: Infinity, duration: 1.8 }} className={cn('mt-0.5 grid h-6 w-6 place-items-center rounded-full border-2', done ? 'border-success bg-success text-white' : current ? 'border-accent bg-accent/20' : 'border-border')}>
              {done ? <Check className="h-3.5 w-3.5" /> : current ? <CircleDot className="h-3.5 w-3.5 text-accent" /> : null}
            </motion.span>
            <div><p className={cn('font-medium', !done && !current && 'text-muted')}>{LABEL[s]}</p>{at && <p className="text-xs text-muted">{dateTime(at)}</p>}</div>
          </li>
        );
      })}
    </ol>
  );
}

const itemRows = (items: any[]) => (
  <ul className="divide-y divide-border text-sm">
    {items.map((i: any, n: number) => <li key={n} className="flex justify-between py-2"><span>{i.quantity} × {i.name}{i.variantName ? ` (${i.variantName})` : ''}{(i.addons ?? []).length > 0 && <span className="block text-xs text-muted">+ {(i.addons as any[]).map((a) => a.name).join(', ')}</span>}{i.status !== 'PENDING' && <span className="block text-xs text-muted">{statusLabel(i.status)}</span>}</span><span>{money(i.lineTotal)}</span></li>)}
  </ul>
);

/** Everything ordered during one table visit, merged into a single view with one section per order. */
function TableVisit({ g }: { g: { tableLabel: string | null; orders: any[]; total: string; thisOrder: number } }) {
  const open = g.orders.filter((o) => !['COMPLETED'].includes(o.status));
  const allPaid = g.orders.every((o) => o.payments.some((p: any) => ['PAID', 'PARTIALLY_REFUNDED'].includes(p.status)));
  return (
    <div className="mx-auto max-w-2xl space-y-6 px-4 py-8">
      <div><p className="text-sm text-muted">Dine in{g.tableLabel ? ` · Table ${g.tableLabel}` : ''}</p><h1 className="text-4xl">Your table’s orders</h1>
        <p className="mt-1 text-sm text-muted">{g.orders.length} orders · {open.length ? `${open.length} still in progress` : 'all served'}</p></div>
      <Card className="flex items-center justify-between p-5"><div><p className="text-sm text-muted">Total for all orders</p><p className="font-display text-3xl">{money(g.total)}</p></div>{allPaid ? <Badge tone="success">Paid</Badge> : <Badge>Pay at the table</Badge>}</Card>
      {g.orders.map((o, idx) => (
        <Card key={o.number} className={cn('space-y-4 p-5', o.number === g.thisOrder && 'ring-2 ring-accent/50')}>
          <div className="flex items-center justify-between"><h2 className="text-xl">Order #{o.number} <span className="text-sm font-normal text-muted">· order {idx + 1} · {dateTime(o.createdAt)}</span></h2><Badge tone={o.status === 'COMPLETED' ? 'success' : 'warn'}>{statusLabel(o.status)}</Badge></div>
          <Steps o={o} />
          {itemRows(o.items)}
          <div className="flex justify-between border-t border-border pt-2 text-sm font-semibold"><span>Order total</span><span>{money(o.total)}</span></div>
        </Card>
      ))}
      <button onClick={() => window.print()} className="no-print text-sm underline">Print receipt</button>
    </div>
  );
}

export default function Track() {
  useSeo('Track your order');
  const { token } = useParams();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['track', token], queryFn: () => api(`/api/public/orders/${token}`), refetchInterval: 15_000 });
  // any order in this table visit changing refreshes the whole view (and the My orders list)
  useRealtime(() => qc.invalidateQueries({ queryKey: ['track'] }), { track: token });

  if (q.isLoading) return <div className="mx-auto max-w-2xl p-6"><Skeleton className="h-96" /></div>;
  if (q.error) return <div className="mx-auto max-w-xl p-8"><ErrorState error={q.error} retry={() => q.refetch()} /></div>;
  const o = q.data;
  if (o.group) return <TableVisit g={o.group} />;
  const steps = FLOW[o.type] ?? FLOW.TAKEAWAY;
  const closed = ['REJECTED', 'CANCELLED'].includes(o.status);
  const idx = steps.indexOf(o.status);
  const paid = o.payments.some((p: any) => p.status === 'PAID' || p.status === 'PARTIALLY_REFUNDED');
  const pendingOnline = o.payments.some((p: any) => p.status === 'PENDING' && !String(p.method).startsWith('CASH'));

  return (
    <div className="mx-auto max-w-2xl space-y-6 px-4 py-8">
      <div><p className="text-sm text-muted">{statusLabel(o.type)} · placed {dateTime(o.createdAt)}</p><h1 className="text-4xl">Order #{o.number}</h1></div>
      {closed ? (
        <Card className="border-danger/40 bg-danger/5 p-5"><p className="font-medium text-danger">This order was {o.status.toLowerCase()}.</p><p className="text-sm text-muted">If you paid, a refund will be issued to your original payment method.</p></Card>
      ) : (
        <Card className="p-5" aria-live="polite">
          <ol className="relative space-y-5">
            {steps.map((s, i) => {
              const done = i < idx || o.status === 'COMPLETED', current = i === idx && o.status !== 'COMPLETED';
              const at = o.history.find((h: any) => h.status === s)?.at;
              return (
                <li key={s} className="flex items-start gap-3">
                  <motion.span animate={current ? { scale: [1, 1.15, 1] } : {}} transition={{ repeat: Infinity, duration: 1.8 }} className={cn('mt-0.5 grid h-6 w-6 place-items-center rounded-full border-2', done ? 'border-success bg-success text-white' : current ? 'border-accent bg-accent/20' : 'border-border')}>
                    {done ? <Check className="h-3.5 w-3.5" /> : current ? <CircleDot className="h-3.5 w-3.5 text-accent" /> : null}
                  </motion.span>
                  <div><p className={cn('font-medium', !done && !current && 'text-muted')}>{LABEL[s]}</p>{at && <p className="text-xs text-muted">{dateTime(at)}</p>}</div>
                </li>
              );
            })}
          </ol>
          {o.status === 'OUT_FOR_DELIVERY' && o.driverName && <p className="mt-4 rounded-xl bg-accent/10 p-3 text-sm">Your driver is {o.driverName}.</p>}
          {!['COMPLETED'].includes(o.status) && <p className="mt-4 text-sm text-muted">Estimated preparation: about {o.prepMinutes} minutes after acceptance.</p>}
        </Card>
      )}
      <Card className="space-y-3 p-5">
        <div className="flex items-center justify-between"><h2 className="text-xl">Your order</h2>
          {paid ? <Badge tone="success">Paid</Badge> : pendingOnline ? <Badge tone="warn">Awaiting payment confirmation</Badge> : <Badge>Pay on {o.type === 'DELIVERY' ? 'delivery' : 'collection'}</Badge>}</div>
        <ul className="divide-y divide-border text-sm">
          {o.items.map((i: any, n: number) => <li key={n} className="flex justify-between py-2"><span>{i.quantity} × {i.name}{i.variantName ? ` (${i.variantName})` : ''}<span className="block text-xs text-muted">{i.status !== 'PENDING' && statusLabel(i.status)}</span></span><span>{money(i.lineTotal)}</span></li>)}
        </ul>
        <dl className="space-y-1 border-t border-border pt-3 text-sm">
          {Number(o.discount) > 0 && <div className="flex justify-between text-success"><dt>Discount</dt><dd>− {money(o.discount)}</dd></div>}
          {Number(o.serviceCharge) > 0 && <div className="flex justify-between"><dt>Service charge</dt><dd>{money(o.serviceCharge)}</dd></div>}
          {Number(o.tax) > 0 && <div className="flex justify-between"><dt>Tax</dt><dd>{money(o.tax)}</dd></div>}
          {Number(o.deliveryFee) > 0 && <div className="flex justify-between"><dt>Delivery</dt><dd>{money(o.deliveryFee)}</dd></div>}
          {Number(o.tip) > 0 && <div className="flex justify-between"><dt>Tip</dt><dd>{money(o.tip)}</dd></div>}
          <div className="flex justify-between text-base font-semibold"><dt>Total</dt><dd>{money(o.total)}</dd></div>
        </dl>
      </Card>
      <button onClick={() => window.print()} className="no-print text-sm underline">Print receipt</button>
    </div>
  );
}
