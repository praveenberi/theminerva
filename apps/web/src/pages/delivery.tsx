import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errMsg, fieldErrors, money } from '../lib';
import { Empty, Field, Page, Skeleton, useToast } from '../ui';

export function DeliveryPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: r } = useQuery({ queryKey: ['restaurant'], queryFn: () => api<any>('/restaurant') });
  const zones = useQuery({ queryKey: ['zones'], queryFn: () => api<any[]>('/delivery/zones') });
  const partners = useQuery({ queryKey: ['partners'], queryFn: () => api<any[]>('/delivery/partners') });
  const active = useQuery({ queryKey: ['deliveries'], queryFn: () => api<any>('/orders?type=DELIVERY&active=1&pageSize=100'), refetchInterval: 8000 });
  const cur = r?.currency ?? 'INR';
  const [z, setZ] = useState({ name: '', fee: 0, min: 0, eta: 45 });
  const [p, setP] = useState({ name: '', phone: '' });
  const [zErr, setZErr] = useState<unknown>(null);
  const [pErr, setPErr] = useState<unknown>(null);
  const run = (fn: () => Promise<unknown>, keys: string[]) => fn().then(() => keys.forEach((k) => qc.invalidateQueries({ queryKey: [k] }))).catch((e) => toast(errMsg(e), 'err'));

  return (
    <Page>
      <h1 className="mb-5 text-2xl font-extrabold">Delivery</h1>
      <div className="grid gap-4 lg:grid-cols-2">
        <section className="card">
          <h2 className="mb-1 font-bold">Delivery zones</h2>
          <p className="mb-3 text-sm text-stone-500">Customers pick their area at checkout; its fee, minimum order and ETA apply. With no zones, the flat fee in Settings is used.</p>
          <form className="mb-3 grid grid-cols-2 gap-2" onSubmit={async (e) => { e.preventDefault(); setZErr(null); try { await api('/delivery/zones', { body: { name: z.name, feeCents: Math.round(z.fee * 100), minOrderCents: Math.round(z.min * 100), etaMinutes: z.eta } }); setZ({ ...z, name: '' }); qc.invalidateQueries({ queryKey: ['zones'] }); toast('Zone added'); } catch (x) { setZErr(x); } }}>
            <div className="col-span-2"><Field label="Zone name" error={(zErr as any)?.status === 409 ? errMsg(zErr) : fieldErrors(zErr, 'name')}><input className="input" placeholder="e.g. Within 3 km" value={z.name} onChange={(e) => setZ({ ...z, name: e.target.value })} /></Field></div>
            <Field label={`Fee (${cur})`}><input className="input" type="number" min={0} step="0.01" value={z.fee} onChange={(e) => setZ({ ...z, fee: Number(e.target.value) })} /></Field>
            <Field label="Minimum order"><input className="input" type="number" min={0} step="0.01" value={z.min} onChange={(e) => setZ({ ...z, min: Number(e.target.value) })} /></Field>
            <Field label="ETA (minutes)"><input className="input" type="number" min={5} max={240} value={z.eta} onChange={(e) => setZ({ ...z, eta: Number(e.target.value) })} /></Field>
            <div className="self-end"><button className="btn-primary w-full" disabled={!z.name.trim()}>Add zone</button></div>
          </form>
          {zones.isLoading ? <Skeleton /> : !zones.data?.length ? <p className="text-sm text-stone-500">No zones yet.</p> : zones.data.map((x) => (
            <div key={x.id} className="flex items-center justify-between border-t border-stone-100 py-2 text-sm">
              <div><p className={`font-semibold ${x.active ? '' : 'text-stone-400 line-through'}`}>{x.name}</p><p className="text-xs text-stone-500">{money(x.feeCents, cur)} fee · min {money(x.minOrderCents, cur)} · ~{x.etaMinutes} min</p></div>
              <div className="flex gap-1.5"><button className="btn-ghost px-2 py-1 text-xs" onClick={() => run(() => api(`/delivery/zones/${x.id}`, { method: 'PATCH', body: { active: !x.active } }), ['zones'])}>{x.active ? 'Disable' : 'Enable'}</button>
                <button className="btn-ghost px-2 py-1 text-xs text-red-600" onClick={() => confirm(`Delete zone ${x.name}?`) && run(() => api(`/delivery/zones/${x.id}`, { method: 'DELETE' }), ['zones'])}>Delete</button></div>
            </div>))}
        </section>

        <section className="card">
          <h2 className="mb-1 font-bold">Delivery partners</h2>
          <p className="mb-3 text-sm text-stone-500">Your riders. A partner must be assigned before an order can go out for delivery.</p>
          <form className="mb-3 grid grid-cols-2 gap-2" onSubmit={async (e) => { e.preventDefault(); setPErr(null); try { await api('/delivery/partners', { body: p }); setP({ name: '', phone: '' }); qc.invalidateQueries({ queryKey: ['partners'] }); toast('Partner added'); } catch (x) { setPErr(x); } }}>
            <Field label="Name" error={(pErr as any)?.status === 409 ? errMsg(pErr) : fieldErrors(pErr, 'name')}><input className="input" value={p.name} onChange={(e) => setP({ ...p, name: e.target.value })} /></Field>
            <Field label="Phone" error={fieldErrors(pErr, 'phone')}><input className="input" type="tel" value={p.phone} onChange={(e) => setP({ ...p, phone: e.target.value })} /></Field>
            <div className="col-span-2"><button className="btn-primary" disabled={!p.name.trim() || !p.phone.trim()}>Add partner</button></div>
          </form>
          {partners.isLoading ? <Skeleton /> : !partners.data?.length ? <p className="text-sm text-stone-500">No partners yet.</p> : partners.data.map((x) => (
            <div key={x.id} className="flex items-center justify-between border-t border-stone-100 py-2 text-sm">
              <div><p className={`font-semibold ${x.active ? '' : 'text-stone-400 line-through'}`}>{x.name}</p><p className="text-xs text-stone-500">{x.phone}</p></div>
              <div className="flex gap-1.5"><button className="btn-ghost px-2 py-1 text-xs" onClick={() => run(() => api(`/delivery/partners/${x.id}`, { method: 'PATCH', body: { active: !x.active } }), ['partners'])}>{x.active ? 'Deactivate' : 'Activate'}</button>
                <button className="btn-ghost px-2 py-1 text-xs text-red-600" onClick={() => confirm(`Delete ${x.name}?`) && run(() => api(`/delivery/partners/${x.id}`, { method: 'DELETE' }), ['partners'])}>Delete</button></div>
            </div>))}
        </section>
      </div>

      <h2 className="mb-2 mt-8 text-lg font-bold">Active deliveries</h2>
      {active.isLoading ? <Skeleton /> : !active.data?.items.length ? <Empty title="No deliveries in progress" /> : (
        <div className="card overflow-x-auto p-0"><table className="w-full text-left text-sm">
          <thead className="bg-stone-50 text-xs uppercase text-stone-500"><tr>{['#', 'Customer', 'Address', 'Zone', 'Status', 'Rider'].map((h) => <th key={h} className="px-4 py-3">{h}</th>)}</tr></thead>
          <tbody>{active.data.items.map((o: any) => (
            <tr key={o.id} className="border-t border-stone-100"><td className="px-4 py-3 font-semibold">#{o.number}</td><td className="px-4 py-3">{o.customerName}<div className="text-xs text-stone-500">{o.customerPhone}</div></td>
              <td className="max-w-[16rem] px-4 py-3">{o.address}</td><td className="px-4 py-3">{o.deliveryZone?.name ?? '—'}</td><td className="px-4 py-3">{o.status.replace(/_/g, ' ')}</td>
              <td className="px-4 py-3"><PartnerSelect order={o} partners={partners.data ?? []} onDone={() => qc.invalidateQueries({ queryKey: ['deliveries'] })} /></td></tr>))}</tbody></table></div>
      )}
    </Page>
  );
}

export function PartnerSelect({ order, partners, onDone }: { order: any; partners: any[]; onDone: () => void }) {
  const toast = useToast();
  const locked = order.status === 'OUT_FOR_DELIVERY';
  return (
    <select className="input w-auto py-1.5 text-xs" value={order.deliveryPartner?.id ?? ''} disabled={locked} aria-label={`Rider for order ${order.number}`}
      onChange={(e) => api(`/orders/${order.id}/delivery`, { method: 'PATCH', body: { partnerId: e.target.value || null } }).then(onDone).catch((x) => toast(errMsg(x), 'err'))}>
      <option value="">Unassigned</option>
      {partners.filter((x) => x.active || x.id === order.deliveryPartner?.id).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
    </select>
  );
}
