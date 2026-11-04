import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Lock } from 'lucide-react';
import { api, errMsg, money, safeRedirect, useAuth } from '../lib';
import { Empty, Page, Skeleton, useToast } from '../ui';

export interface Entitlements { status: string; operational: boolean; trial: boolean; features: string[]; limits: { maxOutlets: number | null; maxStaff: number | null; maxProducts: number | null }; planName: string; daysLeft: number | null; cancelAtPeriodEnd: boolean }

export const useEntitlements = () => useQuery({ queryKey: ['entitlements'], queryFn: () => api<Entitlements>('/entitlements'), staleTime: 30_000 });

const FEATURE_LABELS: Record<string, string> = {
  online_payments: 'Online payments', reservations: 'Table reservations', crm: 'Customer CRM', promotions: 'Promotions & coupons',
  loyalty: 'Loyalty & referrals', inventory: 'Inventory & recipes', marketing: 'Marketing campaigns', multi_outlet: 'Multiple outlets', advanced_reports: 'Advanced reports & exports',
};
const fmtDate = (d: string | null) => (d ? new Date(d).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
const limitText = (n: number | null, what: string) => (n == null ? `Unlimited ${what}` : `Up to ${n} ${what}`);
export const priceText = (p: { priceCents: number; currency: string; intervalMonths: number }) =>
  `${money(p.priceCents, p.currency)} / ${p.intervalMonths === 1 ? 'month' : `${p.intervalMonths} months`}`;

/** Wraps a page that needs a plan feature: shows an upgrade prompt instead of an error. */
export function Gated({ feature, label, children }: { feature: string; label: string; children: React.ReactNode }) {
  const { data } = useEntitlements();
  const { me } = useAuth();
  if (!data) return <Skeleton className="h-40" />;
  if (data.operational && data.features.includes(feature)) return <>{children}</>;
  return (
    <Page>
      <div className="mx-auto max-w-md pt-10"><div className="card text-center">
        <Lock className="mx-auto mb-3 text-stone-400" />
        <h1 className="text-lg font-bold">{data.operational ? `${label} isn’t in your ${data.planName} plan` : 'Your subscription isn’t active'}</h1>
        <p className="mt-1 text-sm text-stone-600">{me!.role === 'OWNER' ? (data.operational ? 'Upgrade your plan to unlock it.' : 'Renew your subscription to use this.') : 'Ask the restaurant owner to upgrade the plan.'}</p>
        {me!.role === 'OWNER' && <Link className="btn-primary mt-4" to="/app/billing">See plans</Link>}
      </div></div>
    </Page>
  );
}

/** Slim strip above every dashboard page when the subscription needs attention. */
export function SubscriptionBanner() {
  const { data } = useEntitlements();
  const { me } = useAuth();
  if (!data) return null;
  const owner = me!.role === 'OWNER';
  const link = owner && <Link to="/app/billing" className="ml-2 font-bold underline">Open billing</Link>;
  if (!data.operational) return <div className="bg-red-600 px-4 py-2 text-sm text-white" role="alert">Subscription ended. Your storefront has stopped taking new orders. {owner ? link : 'Ask the owner to renew.'}</div>;
  if (data.status === 'PAST_DUE') return <div className="bg-amber-500 px-4 py-2 text-sm text-white" role="alert">Payment due. Pay your invoice to avoid losing access. {owner ? link : 'Tell the owner.'}</div>;
  if (data.trial) return <div className="bg-brand-50 px-4 py-2 text-sm text-brand-700">Free trial: {data.daysLeft} day{data.daysLeft === 1 ? '' : 's'} left with every feature unlocked. {link}</div>;
  if (data.cancelAtPeriodEnd) return <div className="bg-stone-200 px-4 py-2 text-sm">Your subscription ends in {data.daysLeft} day{data.daysLeft === 1 ? '' : 's'}. {link}</div>;
  return null;
}

export function BillingPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const { data, isLoading, error } = useQuery({ queryKey: ['billing'], queryFn: () => api<any>('/billing') });
  const [busy, setBusy] = useState<string | null>(null);
  const refresh = () => { qc.invalidateQueries({ queryKey: ['billing'] }); qc.invalidateQueries({ queryKey: ['entitlements'] }); };

  if (isLoading) return <Skeleton className="h-64" />;
  if (error || !data) return <Empty title="Couldn’t load billing" hint={errMsg(error)} />;
  const { subscription: s, usage, plans, invoices } = data;
  const e = data.entitlements;
  const current = s.plan;
  const mine = (p: any) => p.code === current.code;
  const perMonth = (p: any) => p.priceCents / p.intervalMonths;
  const fresh = ['TRIALING', 'CANCELED', 'EXPIRED'].includes(s.status);

  const go = async (fn: () => Promise<any>, key: string) => {
    setBusy(key);
    try {
      const r = await fn();
      if (r?.payUrl) { if (!safeRedirect(r.payUrl)) throw new Error('The payment page link looks invalid. Please try again.'); return; }
      if (r?.result === 'scheduled') toast(`Downgrade scheduled for ${fmtDate(r.at)}. You keep your current plan until then.`);
      else if (r?.result === 'unscheduled') toast('Scheduled downgrade cancelled.');
      else if (r?.result === 'activated') toast('Plan changed.');
      refresh();
    } catch (x) { toast(errMsg(x), 'err'); } finally { setBusy(null); }
  };
  const choose = (p: any) => go(() => api('/billing/change', { body: { planCode: p.code } }), p.code);
  const label = (p: any) => {
    if (mine(p)) return s.pendingPlan ? 'Keep this plan' : fresh ? 'Subscribe' : 'Current plan';
    if (s.pendingPlan?.code === p.code) return 'Scheduled';
    if (fresh) return 'Subscribe';
    return perMonth(p) > perMonth(current) ? 'Upgrade now' : 'Downgrade at renewal';
  };
  const disabled = (p: any) => !!busy || (mine(p) && !s.pendingPlan && !fresh) || s.pendingPlan?.code === p.code || s.status === 'PAST_DUE';
  const statusText = { TRIALING: 'Free trial', ACTIVE: 'Active', PAST_DUE: 'Payment due', CANCELED: 'Cancelled', EXPIRED: 'Expired' }[s.status as string] ?? s.status;

  return (
    <Page>
      <h1 className="mb-5 text-2xl font-extrabold">Billing</h1>
      {!data.paymentsAvailable && <p className="mb-4 rounded-xl bg-amber-50 p-3 text-sm text-amber-900" role="status">No payment provider is connected on this server, so invoices can’t be paid online yet. See the README (Stripe / Razorpay).</p>}

      <section className="card mb-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div><p className="text-sm text-stone-500">Current plan</p><p className="text-2xl font-extrabold">{current.name} <span className={`ml-1 rounded-full px-2.5 py-0.5 align-middle text-xs font-semibold ${s.status === 'ACTIVE' ? 'bg-green-100 text-green-800' : s.status === 'TRIALING' ? 'bg-brand-100 text-brand-700' : 'bg-red-100 text-red-700'}`}>{statusText}</span></p>
            <p className="mt-1 text-sm text-stone-600">
              {s.status === 'TRIALING' && <>Trial ends {fmtDate(s.trialEndsAt)}. Everything is unlocked until then.</>}
              {s.status === 'ACTIVE' && <>{priceText(current)} · {s.cancelAtPeriodEnd ? 'ends' : 'renews'} on {fmtDate(s.currentPeriodEnd)}</>}
              {s.status === 'PAST_DUE' && <>Your invoice is overdue. Pay it below to keep your account.</>}
              {['CANCELED', 'EXPIRED'].includes(s.status) && <>Ended {fmtDate(s.currentPeriodEnd)}. Choose a plan to reopen your storefront.</>}
            </p>
            {s.pendingPlan && <p className="mt-1 text-sm text-amber-700">Moving to {s.pendingPlan.name} on {fmtDate(s.currentPeriodEnd)}.</p>}
          </div>
          <div className="flex gap-2">
            {['ACTIVE', 'TRIALING', 'PAST_DUE'].includes(s.status) && (s.cancelAtPeriodEnd
              ? <button className="btn-primary" disabled={!!busy} onClick={() => go(() => api('/billing/resume', { body: {} }), 'resume')}>Keep my subscription</button>
              : <button className="btn-ghost text-red-600" disabled={!!busy} onClick={() => confirm(s.status === 'TRIALING' ? 'Cancel at the end of your trial?' : `Cancel at the end of the period (${fmtDate(s.currentPeriodEnd)})? You keep access until then.`) && go(() => api('/billing/cancel', { body: {} }), 'cancel')}>Cancel subscription</button>)}
          </div>
        </div>
        <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-3">
          {[['Outlets', usage.outlets, e.limits.maxOutlets], ['Staff accounts', usage.staff, e.limits.maxStaff], ['Menu items (this outlet)', usage.products, e.limits.maxProducts]].map(([k, used, max]) => (
            <div key={k as string} className="rounded-xl bg-stone-100 p-3"><dt className="text-stone-500">{k}</dt><dd className="font-bold">{used as number} <span className="font-normal text-stone-500">/ {max == null ? 'unlimited' : max}</span></dd></div>))}
        </dl>
      </section>

      <h2 className="mb-2 text-lg font-bold">Plans</h2>
      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {plans.map((p: any) => (
          <div key={p.code} className={`card flex flex-col ${mine(p) ? 'ring-2 ring-brand-500' : ''}`}>
            <p className="font-bold">{p.name}</p>
            <p className="mt-1 text-xl font-extrabold">{money(p.priceCents, p.currency)}<span className="text-sm font-normal text-stone-500"> / {p.intervalMonths === 1 ? 'mo' : `${p.intervalMonths} mo`}</span></p>
            <p className="mt-1 text-xs text-stone-500">{p.description}</p>
            <ul className="my-3 flex-1 space-y-1 text-sm">
              <li className="text-stone-600">{limitText(p.limits.maxStaff, 'staff')}</li><li className="text-stone-600">{limitText(p.limits.maxProducts, 'menu items')}</li><li className="text-stone-600">{limitText(p.limits.maxOutlets, p.limits.maxOutlets === 1 ? 'outlet' : 'outlets')}</li>
              {p.features.map((f: string) => <li key={f} className="flex items-center gap-1.5"><Check size={14} className="text-green-600" />{FEATURE_LABELS[f] ?? f}</li>)}
            </ul>
            <button className={mine(p) && !fresh && !s.pendingPlan ? 'btn-ghost' : 'btn-primary'} disabled={disabled(p)} onClick={() => choose(p)}>{busy === p.code ? 'Working…' : label(p)}</button>
          </div>))}
      </div>
      <p className="mb-6 text-xs text-stone-500">Upgrades take effect immediately and are charged pro rata for the rest of your current period. Downgrades start at your next renewal. Invoices are paid through our payment provider; cards are not charged automatically.</p>

      <h2 className="mb-2 text-lg font-bold">Invoices</h2>
      {invoices.length === 0 ? <Empty title="No invoices yet" hint="Your first invoice appears when you subscribe or your trial ends." /> : (
        <div className="card overflow-x-auto p-0"><table className="w-full text-left text-sm">
          <thead className="bg-stone-50 text-xs uppercase text-stone-500"><tr>{['No.', 'Date', 'Description', 'Amount', 'Status', ''].map((h) => <th key={h} className="px-4 py-3">{h}</th>)}</tr></thead>
          <tbody>{invoices.map((i: any) => (
            <tr key={i.id} className="border-t border-stone-100"><td className="px-4 py-3 font-semibold">#{i.number}</td><td className="px-4 py-3">{fmtDate(i.createdAt)}</td><td className="px-4 py-3">{i.description}</td><td className="px-4 py-3">{money(i.amountCents, i.currency)}</td>
              <td className="px-4 py-3"><span className={i.status === 'PAID' ? 'text-green-700' : i.status === 'OPEN' ? 'font-semibold text-amber-700' : 'text-stone-400'}>{i.status.toLowerCase()}</span></td>
              <td className="px-4 py-3 text-right">{i.status === 'OPEN' && <button className="btn-primary px-3 py-1.5 text-xs" disabled={!!busy} onClick={() => go(() => api(`/billing/invoices/${i.id}/pay`, { body: {} }), i.id)}>Pay now</button>}</td></tr>))}</tbody></table></div>
      )}
    </Page>
  );
}
