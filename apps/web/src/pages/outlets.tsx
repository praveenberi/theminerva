import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import { api, errMsg, fieldErrors, money, setToken, useAuth } from '../lib';
import { Empty, Field, Page, Skeleton, useToast } from '../ui';

export function useSwitchOutlet() {
  const { me, setMe } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  return async (restaurantId: string) => {
    try {
      const r = await api<{ accessToken: string; restaurant: { id: string; slug: string; name: string } }>('/auth/switch-outlet', { body: { restaurantId } });
      setToken(r.accessToken);
      setMe({ ...me!, restaurant: r.restaurant });
      qc.clear(); // every cached query belonged to the previous outlet
      qc.invalidateQueries();
    } catch (e) { toast(errMsg(e), 'err'); }
  };
}

export function OutletsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const switchTo = useSwitchOutlet();
  const [range, setRange] = useState('7d');
  const list = useQuery({ queryKey: ['outlets'], queryFn: () => api<any>('/outlets') });
  const cmp = useQuery({ queryKey: ['outlets-compare', range], queryFn: () => api<any>(`/outlets/compare?range=${range}&tzOffset=${new Date().getTimezoneOffset()}`) });
  const customers = useQuery({ queryKey: ['outlets-customers'], queryFn: () => api<any[]>('/outlets/customers') });
  const [f, setF] = useState({ name: '', address: '', copyMenuFrom: '' });
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const cur = cmp.data?.outlets[0]?.currency;

  const add = async (e: React.FormEvent) => {
    e.preventDefault(); setErr(null); setBusy(true);
    try {
      await api('/outlets', { body: { name: f.name, address: f.address || undefined, copyMenuFrom: f.copyMenuFrom || undefined } });
      setF({ name: '', address: '', copyMenuFrom: '' });
      qc.invalidateQueries({ queryKey: ['outlets'] }); qc.invalidateQueries({ queryKey: ['outlets-compare'] });
      toast('Outlet created. It is unpublished until you switch to it and publish it in Settings.');
    } catch (x) { setErr(x); } finally { setBusy(false); }
  };

  return (
    <Page>
      <h1 className="mb-5 text-2xl font-extrabold">Outlets</h1>
      {list.isLoading ? <Skeleton className="h-32" /> : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {list.data.outlets.map((o: any) => (
              <div key={o.id} className={`card ${o.current ? 'ring-2 ring-brand-500' : ''}`}>
                <p className="font-bold">{o.name}</p><p className="text-sm text-stone-500">{o.address || 'No address yet'}</p>
                <p className="mt-1 text-xs">{o.published ? <span className="text-green-700">Live</span> : <span className="text-amber-700">Not published</span>}{o.current && ' · working here'}</p>
                <div className="mt-3 flex gap-2">
                  {!o.current && <button className="btn-primary px-3 py-1.5 text-xs" onClick={() => switchTo(o.id)}>Switch to this outlet</button>}
                  <a className="btn-ghost px-3 py-1.5 text-xs" href={`/r/${o.slug}`} target="_blank" rel="noreferrer"><ExternalLink size={14} /> Storefront</a>
                </div>
              </div>))}
          </div>
          <p className="mt-3 text-sm text-stone-500">{list.data.outlets.length} of {list.data.maxOutlets} outlets used.</p>

          {list.data.canAdd ? (
            <form onSubmit={add} className="card mt-4 grid gap-3 sm:grid-cols-4">
              <Field label="New outlet name" error={fieldErrors(err, 'name')}><input className="input" placeholder="e.g. Demo Bistro – Indiranagar" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
              <Field label="Address"><input className="input" value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} /></Field>
              <Field label="Start with menu from"><select className="input" value={f.copyMenuFrom} onChange={(e) => setF({ ...f, copyMenuFrom: e.target.value })}><option value="">Empty menu</option>{list.data.outlets.map((o: any) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></Field>
              <div className="self-end"><button className="btn-primary w-full" disabled={busy || f.name.trim().length < 2}>{busy ? 'Creating…' : 'Add outlet'}</button></div>
              {!!err && !fieldErrors(err, 'name') && <p className="err sm:col-span-4" role="alert">{errMsg(err)}</p>}
              <p className="text-xs text-stone-500 sm:col-span-4">A copied menu is independent: changing prices or availability at one outlet never affects another. Inventory, tables, coupons and delivery zones start empty.</p>
            </form>
          ) : <p className="mt-4 rounded-xl bg-stone-100 p-3 text-sm text-stone-600">Your plan allows {list.data.maxOutlets} outlet{list.data.maxOutlets === 1 ? '' : 's'}. Contact support to add more.</p>}
        </>
      )}

      <div className="mb-2 mt-8 flex items-center justify-between"><h2 className="text-lg font-bold">Performance by outlet</h2>
        <select className="input w-auto" value={range} onChange={(e) => setRange(e.target.value)} aria-label="Date range"><option value="today">Today</option><option value="yesterday">Yesterday</option><option value="7d">Last 7 days</option><option value="30d">Last 30 days</option></select></div>
      {cmp.isLoading ? <Skeleton /> : (
        <div className="card overflow-x-auto p-0"><table className="w-full text-left text-sm">
          <thead className="bg-stone-50 text-xs uppercase text-stone-500"><tr>{['Outlet', 'Revenue', 'Orders', 'Avg. order', 'Cancelled', 'Reservations'].map((h) => <th key={h} className="px-4 py-3">{h}</th>)}</tr></thead>
          <tbody>{cmp.data.outlets.map((o: any) => <tr key={o.id} className="border-t border-stone-100"><td className="px-4 py-3 font-semibold">{o.name}</td><td className="px-4 py-3">{money(o.revenueCents, o.currency)}</td><td className="px-4 py-3">{o.orders}</td><td className="px-4 py-3">{money(o.averageOrderCents, o.currency)}</td><td className="px-4 py-3">{o.cancelledOrders}</td><td className="px-4 py-3">{o.reservations}</td></tr>)}
            <tr className="border-t-2 border-stone-200 font-bold"><td className="px-4 py-3">All outlets</td><td className="px-4 py-3">{cmp.data.totalRevenueCents != null ? money(cmp.data.totalRevenueCents, cur) : 'mixed currencies'}</td><td className="px-4 py-3">{cmp.data.totalOrders}</td><td colSpan={3} /></tr></tbody></table></div>
      )}

      <h2 className="mb-2 mt-8 text-lg font-bold">Customers across outlets</h2>
      {customers.isLoading ? <Skeleton /> : !customers.data?.length ? <Empty title="No customers yet" hint="One profile per phone number, combined across all your outlets." /> : (
        <div className="card overflow-x-auto p-0"><table className="w-full text-left text-sm">
          <thead className="bg-stone-50 text-xs uppercase text-stone-500"><tr>{['Name', 'Phone', 'Outlets visited', 'Orders', 'Total spent', 'Loyalty points'].map((h) => <th key={h} className="px-4 py-3">{h}</th>)}</tr></thead>
          <tbody>{customers.data.map((c) => <tr key={c.phone} className="border-t border-stone-100"><td className="px-4 py-3 font-semibold">{c.name}</td><td className="px-4 py-3">{c.phone}</td><td className="px-4 py-3">{c.outlets}</td><td className="px-4 py-3">{c.orders}</td><td className="px-4 py-3">{money(c.spent, cur)}</td><td className="px-4 py-3">{c.points}</td></tr>)}</tbody></table></div>
      )}
    </Page>
  );
}
