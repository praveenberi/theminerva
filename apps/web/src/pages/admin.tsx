import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChefHat, LogOut } from 'lucide-react';
import { api, errMsg, fieldErrors, money, useAuth } from '../lib';
import { Empty, Field, Modal, Page, Skeleton, useToast } from '../ui';
import { SecuritySection } from './account';
import { ApiError } from '../lib';

const FEATURES: [string, string][] = [['online_payments', 'Online payments'], ['reservations', 'Reservations'], ['crm', 'Customer CRM'], ['promotions', 'Promotions'], ['loyalty', 'Loyalty'], ['inventory', 'Inventory'], ['marketing', 'Marketing campaigns'], ['multi_outlet', 'Multiple outlets'], ['advanced_reports', 'Advanced reports']];
const date = (d: string | null) => (d ? new Date(d).toLocaleDateString() : '—');

export function AdminPage() {
  const { logout } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const stats = useQuery({ queryKey: ['admin-stats'], queryFn: () => api<any>('/admin/stats') });
  const list = useQuery({ queryKey: ['admin-restaurants'], queryFn: () => api<any[]>('/admin/restaurants') });
  const plans = useQuery({ queryKey: ['admin-plans'], queryFn: () => api<any[]>('/admin/plans') });
  const subs = useQuery({ queryKey: ['admin-subs'], queryFn: () => api<any[]>('/admin/subscriptions') });
  const [editing, setEditing] = useState<any | null>(null);
  const refresh = () => ['admin-restaurants', 'admin-subs', 'admin-plans', 'admin-stats'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
  const update = useMutation({
    mutationFn: ({ id, ...body }: { id: string; status?: string; maxOutlets?: number }) => api(`/admin/tenants/${id}`, { method: 'PATCH', body }),
    onSuccess: refresh, onError: (e) => toast(errMsg(e), 'err'),
  });
  const override = useMutation({
    mutationFn: ({ tenantId, ...body }: { tenantId: string; planCode?: string; extendDays?: number; status?: string }) => api(`/admin/subscriptions/${tenantId}`, { method: 'PATCH', body }),
    onSuccess: () => { refresh(); toast('Subscription updated'); }, onError: (e) => toast(errMsg(e), 'err'),
  });
  const runJob = async () => { try { const r = await api<any>('/admin/billing/run', { body: {} }); toast(`Billing run: ${r.invoiced} invoiced, ${r.expired} expired, ${r.canceled} cancelled`); refresh(); } catch (e) { toast(errMsg(e), 'err'); } };

  return (
    <Page>
      <div className="mx-auto max-w-6xl p-4 sm:p-6">
        <div className="mb-6 flex items-center justify-between"><h1 className="flex items-center gap-2 text-2xl font-extrabold"><ChefHat className="text-brand-500" /> Platform admin</h1><button className="btn-ghost" onClick={logout}><LogOut size={16} /> Log out</button></div>
        {(stats.error instanceof ApiError && stats.error.code === 'mfa_setup_required') && (
          <div className="mb-6 rounded-xl bg-amber-50 p-4 text-sm text-amber-900" role="alert"><b>Two-step verification is required for the platform admin.</b> Turn it on below to continue.</div>
        )}
        <div className="mb-6 grid gap-3 sm:grid-cols-3">
          {[['Restaurants', stats.data?.restaurants], ['Orders', stats.data?.orders], ['Gross order value', stats.data && money(stats.data.gmvCents)]].map(([k, v]) => <div key={k as string} className="card"><p className="text-sm text-stone-500">{k}</p><p className="mt-1 text-2xl font-extrabold">{v ?? '…'}</p></div>)}
        </div>

        <div className="mb-2 flex items-center justify-between"><h2 className="text-lg font-bold">Plans</h2><button className="btn-primary" onClick={() => setEditing({ code: '', name: '', description: '', priceCents: 0, currency: 'INR', intervalMonths: 1, trialDays: 14, limits: { maxOutlets: 1, maxStaff: null, maxProducts: null }, features: [], active: true, sort: (plans.data?.length ?? 0) + 1, isNew: true })}>New plan</button></div>
        {plans.isLoading ? <Skeleton className="mb-6 h-32" /> : (
          <div className="card mb-8 overflow-x-auto p-0"><table className="w-full text-left text-sm">
            <thead className="bg-stone-50 text-xs uppercase text-stone-500"><tr>{['Plan', 'Price', 'Trial', 'Limits (outlets / staff / items)', 'Features', 'Subscribers', ''].map((h) => <th key={h} className="px-4 py-3">{h}</th>)}</tr></thead>
            <tbody>{plans.data!.map((p) => (
              <tr key={p.id} className={`border-t border-stone-100 ${p.active ? '' : 'text-stone-400'}`}><td className="px-4 py-3 font-semibold">{p.name} <span className="text-xs font-normal">{p.code}{!p.active && ' · hidden'}</span></td>
                <td className="px-4 py-3">{money(p.priceCents, p.currency)} / {p.intervalMonths} mo</td><td className="px-4 py-3">{p.trialDays}d</td>
                <td className="px-4 py-3">{[p.limits.maxOutlets, p.limits.maxStaff, p.limits.maxProducts].map((n) => n ?? '∞').join(' / ')}</td><td className="max-w-[16rem] px-4 py-3 text-xs">{p.features.join(', ') || '—'}</td><td className="px-4 py-3">{p.subscribers}</td>
                <td className="px-4 py-3 text-right"><button className="btn-ghost px-3 py-1.5 text-xs" onClick={() => setEditing({ ...p })}>Edit</button></td></tr>))}</tbody></table></div>
        )}

        <div className="mb-2 flex items-center justify-between"><h2 className="text-lg font-bold">Subscriptions</h2><button className="btn-ghost" onClick={runJob}>Run billing job now</button></div>
        {subs.isLoading ? <Skeleton className="mb-6 h-32" /> : !subs.data?.length ? <Empty title="No subscriptions yet" /> : (
          <div className="card mb-8 overflow-x-auto p-0"><table className="w-full text-left text-sm">
            <thead className="bg-stone-50 text-xs uppercase text-stone-500"><tr>{['Business', 'Plan', 'Status', 'Period ends', ''].map((h) => <th key={h} className="px-4 py-3">{h}</th>)}</tr></thead>
            <tbody>{subs.data.slice(0, 50).map((s) => (
              <tr key={s.tenantId} className="border-t border-stone-100"><td className="px-4 py-3 font-semibold">{s.name}</td>
                <td className="px-4 py-3"><select className="input w-auto py-1" value={s.planCode} aria-label={`Plan for ${s.name}`} onChange={(e) => override.mutate({ tenantId: s.tenantId, planCode: e.target.value })}>{plans.data?.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}</select></td>
                <td className="px-4 py-3">{s.status.toLowerCase().replace('_', ' ')}{s.cancelAtPeriodEnd && ' · cancelling'}</td><td className="px-4 py-3">{date(s.status === 'TRIALING' ? s.trialEndsAt : s.currentPeriodEnd)}</td>
                <td className="space-x-1 px-4 py-3 text-right"><button className="btn-ghost px-2.5 py-1.5 text-xs" onClick={() => override.mutate({ tenantId: s.tenantId, extendDays: 14 })}>+14 days</button>
                  {s.status !== 'ACTIVE' && <button className="btn-ghost px-2.5 py-1.5 text-xs" onClick={() => override.mutate({ tenantId: s.tenantId, status: 'ACTIVE' })}>Reactivate</button>}</td></tr>))}</tbody></table></div>
        )}

        <h2 className="mb-2 text-lg font-bold">Restaurants</h2>
        {list.isLoading ? <Skeleton className="h-40" /> : !list.data?.length ? <Empty title="No restaurants registered yet" /> : (
          <div className="card overflow-x-auto p-0"><table className="w-full text-left text-sm"><thead className="bg-stone-50 text-xs uppercase text-stone-500"><tr>{['Restaurant', 'Slug', 'Outlet limit', 'Orders', 'Items', 'Account', ''].map((h) => <th key={h} className="px-4 py-3">{h}</th>)}</tr></thead>
            <tbody>{list.data.slice(0, 50).map((r) => (
              <tr key={r.id} className="border-t border-stone-100">
                <td className="px-4 py-3 font-semibold">{r.name}</td><td className="px-4 py-3">{r.slug}</td>
                <td className="px-4 py-3"><input className="input w-20 py-1" type="number" min={1} max={500} defaultValue={r.maxOutlets} aria-label={`Outlet limit for ${r.name}`} onBlur={(e) => { const n = Number(e.target.value); if (Number.isInteger(n) && n >= 1 && n !== r.maxOutlets) update.mutate({ id: r.tenantId, maxOutlets: n }); }} /></td>
                <td className="px-4 py-3">{r.orders}</td><td className="px-4 py-3">{r.products}</td><td className="px-4 py-3">{r.status}</td>
                <td className="px-4 py-3 text-right"><button className={`btn px-3 py-1.5 text-xs ${r.status === 'SUSPENDED' ? 'btn-primary' : 'btn-ghost text-red-600'}`} onClick={() => update.mutate({ id: r.tenantId, status: r.status === 'SUSPENDED' ? 'ACTIVE' : 'SUSPENDED' })}>{r.status === 'SUSPENDED' ? 'Activate' : 'Suspend'}</button></td>
              </tr>))}</tbody></table></div>
        )}
        {(list.data?.length ?? 0) > 50 && <p className="mt-2 text-xs text-stone-500">Showing the first 50 of {list.data!.length}.</p>}
      </div>
      <div className="mx-auto max-w-6xl space-y-5 px-4 pb-10 sm:px-6">
        <SecuritySection intro="The platform admin account can reach every business, so protect it with a second step." />
        <ResetMfa />
      </div>
      <PlanEditor plan={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); refresh(); toast('Plan saved'); }} />
    </Page>
  );
}

function PlanEditor({ plan, onClose, onSaved }: { plan: any | null; onClose: () => void; onSaved: () => void }) {
  const [p, setP] = useState<any>(null);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [source, setSource] = useState<any>(null);
  // reset the form only when a different plan is opened, never while the user is typing
  if (plan && plan !== source) { setSource(plan); setP(plan); setErr(null); }
  if (!plan) return <Modal open={false} onClose={onClose} title="">{null}</Modal>;
  const cur = p ?? plan;
  const num = (k: string) => (e: any) => setP({ ...cur, [k]: e.target.value === '' ? 0 : Number(e.target.value) });
  const lim = (k: string) => (e: any) => setP({ ...cur, limits: { ...cur.limits, [k]: e.target.value === '' ? null : Number(e.target.value) } });
  const save = async () => {
    setBusy(true); setErr(null);
    const { id, isNew, subscribers, ...body } = cur;
    try { await api(isNew ? '/admin/plans' : `/admin/plans/${id}`, { method: isNew ? 'POST' : 'PUT', body }); onSaved(); } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title={cur.isNew ? 'New plan' : `Edit ${cur.name}`}>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Code" error={fieldErrors(err, 'code') ?? ((err as any)?.status === 409 ? errMsg(err) : undefined)}><input className="input uppercase" disabled={!cur.isNew} value={cur.code} onChange={(e) => setP({ ...cur, code: e.target.value })} /></Field>
          <Field label="Name" error={fieldErrors(err, 'name')}><input className="input" value={cur.name} onChange={(e) => setP({ ...cur, name: e.target.value })} /></Field>
        </div>
        <Field label="Description (shown on the pricing page)"><textarea className="input" rows={2} value={cur.description} onChange={(e) => setP({ ...cur, description: e.target.value })} /></Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Price (minor units)" error={fieldErrors(err, 'priceCents')}><input className="input" type="number" min={0} value={cur.priceCents} onChange={num('priceCents')} /></Field>
          <Field label="Currency"><input className="input uppercase" maxLength={3} value={cur.currency} onChange={(e) => setP({ ...cur, currency: e.target.value })} /></Field>
          <Field label="Billed every (months)"><input className="input" type="number" min={1} max={24} value={cur.intervalMonths} onChange={num('intervalMonths')} /></Field>
          <Field label="Free trial (days)"><input className="input" type="number" min={0} max={90} value={cur.trialDays} onChange={num('trialDays')} /></Field>
          <Field label="Sort order"><input className="input" type="number" min={0} value={cur.sort} onChange={num('sort')} /></Field>
          <label className="flex items-center gap-2 self-end pb-2 text-sm font-semibold"><input type="checkbox" checked={cur.active} onChange={(e) => setP({ ...cur, active: e.target.checked })} />Available to customers</label>
        </div>
        <p className="label">Limits (empty = unlimited)</p>
        <div className="grid grid-cols-3 gap-3">
          {[['maxOutlets', 'Outlets'], ['maxStaff', 'Staff'], ['maxProducts', 'Menu items / outlet']].map(([k, l]) => <Field key={k} label={l}><input className="input" type="number" min={1} value={cur.limits[k] ?? ''} onChange={lim(k)} placeholder="∞" /></Field>)}
        </div>
        <div><p className="label">Features</p><div className="grid grid-cols-2 gap-1 text-sm">{FEATURES.map(([k, l]) => <label key={k}><input type="checkbox" className="mr-1.5" checked={cur.features.includes(k)} onChange={() => setP({ ...cur, features: cur.features.includes(k) ? cur.features.filter((x: string) => x !== k) : [...cur.features, k] })} />{l}</label>)}</div></div>
        <p className="text-xs text-stone-500">Price changes apply to invoices created from now on. Feature and limit changes apply to current subscribers immediately.</p>
        {!!err && !fieldErrors(err, 'code') && !fieldErrors(err, 'name') && !fieldErrors(err, 'priceCents') && (err as any)?.status !== 409 && <p className="err" role="alert">{errMsg(err)}</p>}
        <button className="btn-primary w-full" disabled={busy || !cur.name.trim() || !cur.code.trim()} onClick={save}>{busy ? 'Saving…' : 'Save plan'}</button>
      </div>
    </Modal>
  );
}

/** For an owner who lost both their phone and their recovery codes. Emails the owner and is recorded in the audit log. */
function ResetMfa() {
  const toast = useToast();
  const [email, setEmail] = useState('');
  return (
    <section className="card max-w-md">
      <h2 className="font-bold">Reset someone’s two-step verification</h2>
      <p className="mt-1 text-sm text-stone-600">Only after you have confirmed who is asking by another channel. The account owner is emailed and the reset is logged.</p>
      <form className="mt-3 flex gap-2" onSubmit={async (e) => { e.preventDefault(); if (!confirm(`Reset two-step verification for ${email}?`)) return; try { await api('/admin/reset-mfa', { body: { email } }); toast('Reset. They have been signed out and emailed.'); setEmail(''); } catch (x) { toast(errMsg(x), 'err'); } }}>
        <input className="input" type="email" placeholder="owner@example.com" value={email} onChange={(e) => setEmail(e.target.value)} aria-label="Account email" /><button className="btn-ghost" disabled={!email.includes('@')}>Reset</button>
      </form>
    </section>
  );
}
