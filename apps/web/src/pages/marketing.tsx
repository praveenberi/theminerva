import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Gift, Send } from 'lucide-react';
import { api, errMsg, fieldErrors, money, useAuth } from '../lib';
import { Empty, Field, Modal, Page, Skeleton, useToast } from '../ui';

const Title = ({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) => <div className="mb-5 flex items-center justify-between gap-3"><h1 className="text-2xl font-extrabold">{children}</h1>{action}</div>;
const fmtDate = (d: string | null) => (d ? new Date(d).toLocaleDateString() : '—');

// ---------------- Loyalty settings ----------------
export function LoyaltyPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const { me } = useAuth();
  const { data, isLoading } = useQuery({ queryKey: ['loyalty'], queryFn: () => api<{ enabled: boolean; config: any }>('/loyalty/config') });
  const [f, setF] = useState<any>(null);
  const [err, setErr] = useState<unknown>(null);
  const isOwner = me!.role === 'OWNER';
  if (data && !f) setF({ enabled: data.enabled, ...data.config });
  if (isLoading || !f) return <Skeleton className="h-64" />;
  const num = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value === '' ? '' : Number(e.target.value) });
  const inp = (k: string, label: string, hint?: string, step: string = '1') => (
    <Field label={label} error={fieldErrors(err, k)}>
      <input className="input" type="number" min={0} step={step} value={f[k]} onChange={num(k)} disabled={!isOwner} />{hint && <p className="mt-1 text-xs text-stone-500">{hint}</p>}
    </Field>
  );
  const save = async (e: React.FormEvent) => {
    e.preventDefault(); setErr(null);
    const { enabled, ...config } = f;
    try { await api('/loyalty/config', { method: 'PUT', body: { enabled, config } }); qc.invalidateQueries({ queryKey: ['loyalty'] }); toast('Loyalty settings saved'); } catch (x) { setErr(x); toast(errMsg(x), 'err'); }
  };
  const run = async () => { try { const r = await api<{ issued: number }>('/loyalty/run-birthdays', { body: {} }); toast(r.issued ? `Issued ${r.issued} birthday voucher${r.issued > 1 ? 's' : ''}` : 'No new birthday vouchers today'); } catch (x) { toast(errMsg(x), 'err'); } };
  return (
    <Page>
      <Title>Loyalty & rewards</Title>
      {!isOwner && <p className="mb-3 rounded-xl bg-stone-100 p-3 text-sm text-stone-600">Only the owner can change these rules.</p>}
      <form onSubmit={save} className="grid gap-4 lg:grid-cols-2">
        <section className="card space-y-3">
          <label className="flex items-center gap-2 font-semibold"><input type="checkbox" checked={f.enabled} disabled={!isOwner} onChange={(e) => setF({ ...f, enabled: e.target.checked })} /> Loyalty programme is on</label>
          <h2 className="pt-2 font-bold">Earning & redeeming</h2>
          {inp('pointsPer100', 'Points per 100 spent', 'On the order value after discounts, before tax. Silver/Gold multiply this.', 'any')}
          {inp('pointValueCents', 'Value of one point (minor units)', 'e.g. 100 = one point is worth 1.00 when redeemed.')}
          {inp('minRedeemPoints', 'Minimum points to redeem')}
          <p className="text-xs text-stone-500">Redeeming turns points into a single-use voucher that only works with the customer's phone number.</p>
        </section>
        <section className="card space-y-3">
          <h2 className="font-bold">Membership levels</h2>
          <p className="text-xs text-stone-500">Levels use lifetime points earned (spending points never lowers a level).</p>
          <div className="grid grid-cols-2 gap-3">
            {inp('silverAt', 'Silver from (points)')}{inp('silverMultiplier', 'Silver earns ×', undefined, 'any')}
            {inp('goldAt', 'Gold from (points)')}{inp('goldMultiplier', 'Gold earns ×', undefined, 'any')}
          </div>
          <h2 className="pt-2 font-bold">Referrals</h2>
          {inp('referralBonusPoints', 'Bonus for both friends (points)', 'Paid once, when the new friend’s first order is completed.')}
          {inp('referralMinOrderCents', 'Friend’s minimum first order (minor units)')}
          {inp('referralMaxRewards', 'Max rewarded referrals per customer', 'Stops one person farming bonuses.')}
        </section>
        <section className="card space-y-3 lg:col-span-2">
          <h2 className="font-bold">Birthday reward</h2>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.birthdayEnabled} disabled={!isOwner} onChange={(e) => setF({ ...f, birthdayEnabled: e.target.checked })} /> Give customers a voucher on their birthday (only those who shared a birthday at checkout)</label>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Type"><select className="input" value={f.birthdayType} disabled={!isOwner} onChange={(e) => setF({ ...f, birthdayType: e.target.value })}><option value="PERCENT">Percent off</option><option value="FIXED">Fixed amount</option></select></Field>
            {inp('birthdayValue', f.birthdayType === 'PERCENT' ? 'Percent' : 'Amount (minor units)')}{inp('birthdayValidDays', 'Valid for (days)')}
          </div>
          <div className="flex gap-2">{isOwner && <button className="btn-primary">Save</button>}<button type="button" className="btn-ghost" onClick={run}><Gift size={16} /> Issue today’s birthday vouchers now</button></div>
          <p className="text-xs text-stone-500">The server also checks automatically every hour. Vouchers appear on the customer’s order tracking page and in their profile; they are not messaged unless you send a campaign.</p>
        </section>
      </form>
    </Page>
  );
}

// ---------------- Customer detail ----------------
export function CustomerModal({ id, currency, onClose, onChanged }: { id: string | null; currency: string; onClose: () => void; onChanged: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { me } = useAuth();
  const { data, isLoading } = useQuery({ queryKey: ['customer', id], enabled: !!id, queryFn: () => api<any>(`/customers/${id}`) });
  const [pts, setPts] = useState('');
  const [adj, setAdj] = useState({ points: '', note: '' });
  const [bday, setBday] = useState<string | null>(null);
  const [made, setMade] = useState<{ code: string; valueCents: number } | null>(null);
  const done = () => { qc.invalidateQueries({ queryKey: ['customer', id] }); onChanged(); };
  const act = (fn: () => Promise<any>, ok: string) => fn().then((r) => { toast(ok); done(); return r; }).catch((e) => toast(errMsg(e), 'err'));
  return (
    <Modal open={!!id} onClose={() => { setMade(null); onClose(); }} title={data?.name ?? 'Customer'}>
      {isLoading || !data ? <Skeleton className="h-40" /> : (
        <div className="space-y-4 text-sm">
          <div className="grid grid-cols-3 gap-2 text-center">
            <div className="rounded-xl bg-stone-100 p-2"><p className="text-xs text-stone-500">Points</p><p className="text-xl font-extrabold">{data.points}</p></div>
            <div className="rounded-xl bg-stone-100 p-2"><p className="text-xs text-stone-500">Level</p><p className="text-xl font-extrabold">{data.tier}</p></div>
            <div className="rounded-xl bg-stone-100 p-2"><p className="text-xs text-stone-500">Referrals</p><p className="text-xl font-extrabold">{data.referrals.REWARDED ?? 0}</p></div>
          </div>
          <p className="text-stone-600">{data.phone}{data.email && ` · ${data.email}`} · Marketing: {data.optedOut ? 'opted out' : data.marketingConsent ? 'agreed' : 'not agreed'}{data.referralCode && ` · Referral code ${data.referralCode}`}</p>

          <div className="rounded-xl ring-1 ring-stone-200 p-3">
            <p className="mb-2 font-semibold">Redeem points for a voucher</p>
            <div className="flex gap-2"><input className="input" type="number" min={data.minRedeemPoints} placeholder={`min ${data.minRedeemPoints}`} value={pts} onChange={(e) => setPts(e.target.value)} aria-label="Points to redeem" />
              <button className="btn-primary" disabled={!pts} onClick={async () => { const r = await act(() => api('/customers/' + id + '/redeem', { body: { points: Number(pts) } }), 'Voucher created'); if (r) { setMade(r); setPts(''); } }}>Redeem</button></div>
            <p className="mt-1 text-xs text-stone-500">Each point = {money(data.pointValueCents, currency)}. Give the code to the customer; it only works with {data.phone}.</p>
            {made && <p className="mt-2 rounded-lg bg-green-50 p-2 text-green-800" role="status">Voucher <b className="font-mono">{made.code}</b> worth {money(made.valueCents, currency)}</p>}
          </div>

          <div><p className="mb-1 font-semibold">Vouchers</p>
            {data.vouchers.length === 0 ? <p className="text-stone-500">None yet.</p> : data.vouchers.map((v: any) => (
              <div key={v.code} className="flex justify-between border-b border-stone-100 py-1"><span className="font-mono">{v.code}</span><span className={v.used ? 'text-stone-400 line-through' : ''}>{v.type === 'PERCENT' ? `${v.value}% off` : money(v.value, currency)} · {v.used ? 'used' : `expires ${fmtDate(v.expiresAt)}`}</span></div>))}</div>

          <div><p className="mb-1 font-semibold">Points history</p>
            <div className="max-h-40 overflow-y-auto">{data.ledger.length === 0 ? <p className="text-stone-500">No activity.</p> : data.ledger.map((l: any) => (
              <div key={l.id} className="flex justify-between border-b border-stone-100 py-1"><span>{l.reason.toLowerCase()}{l.note && <span className="text-stone-500"> · {l.note}</span>}</span><span className={l.delta < 0 ? 'text-red-600' : 'text-green-700'}>{l.delta > 0 ? '+' : ''}{l.delta}</span></div>))}</div></div>

          <div className="flex items-end gap-2"><Field label="Birthday"><input className="input" type="date" value={bday ?? (data.birthday ? data.birthday.slice(0, 10) : '')} onChange={(e) => setBday(e.target.value)} /></Field>
            <button className="btn-ghost" disabled={bday === null} onClick={() => act(() => api(`/customers/${id}`, { method: 'PATCH', body: { birthday: bday || null } }), 'Birthday saved')}>Save</button>
            {!data.optedOut && data.marketingConsent && <button className="btn-ghost text-red-600" onClick={() => confirm('Record that this customer opted out of marketing?') && act(() => api(`/customers/${id}`, { method: 'PATCH', body: { optOut: true } }), 'Marked as opted out')}>Opt out</button>}</div>

          {me!.role === 'OWNER' && (
            <div className="rounded-xl ring-1 ring-stone-200 p-3"><p className="mb-2 font-semibold">Manual correction</p>
              <div className="flex gap-2"><input className="input w-28" type="number" placeholder="+/- points" value={adj.points} onChange={(e) => setAdj({ ...adj, points: e.target.value })} aria-label="Points adjustment" /><input className="input" placeholder="Reason (required)" value={adj.note} onChange={(e) => setAdj({ ...adj, note: e.target.value })} aria-label="Reason" />
                <button className="btn-ghost" disabled={!adj.points || adj.note.trim().length < 3} onClick={() => act(() => api(`/customers/${id}/adjust`, { body: { points: Number(adj.points), note: adj.note } }), 'Points adjusted').then(() => setAdj({ points: '', note: '' }))}>Apply</button></div></div>)}
        </div>
      )}
    </Modal>
  );
}

// ---------------- Campaigns ----------------
const SEGMENTS: [string, string][] = [['ALL', 'All customers who agreed'], ['NEW', 'New (1 order)'], ['RETURNING', 'Returning'], ['VIP', 'VIP'], ['INACTIVE', 'Inactive (60+ days)'], ['BIRTHDAY_MONTH', 'Birthday this month']];

export function MarketingPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const channels = useQuery({ queryKey: ['channels'], queryFn: () => api<{ EMAIL: string | null; WHATSAPP: string | null }>('/marketing/channels') });
  const campaigns = useQuery({ queryKey: ['campaigns'], queryFn: () => api<any[]>('/campaigns'), refetchInterval: (q) => (q.state.data?.some((c: any) => c.status === 'SENDING') ? 2000 : false) });
  const coupons = useQuery({ queryKey: ['coupons'], queryFn: () => api<any[]>('/coupons') });
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<string | null>(null);
  const blank = { name: '', channel: 'EMAIL', segment: 'ALL', subject: '', body: 'Hi {{name}}, ', couponCode: '' };
  const [f, setF] = useState(blank);
  const [err, setErr] = useState<unknown>(null);
  const general = (coupons.data ?? []).filter((c) => !c.customerPhone && c.active);
  const refresh = () => qc.invalidateQueries({ queryKey: ['campaigns'] });
  const preset = (kind: 'winback' | 'birthday') => { setF(kind === 'winback'
    ? { ...blank, name: 'Win-back', segment: 'INACTIVE', subject: 'We miss you!', body: 'Hi {{name}}, it has been a while. Show code {{code}} on your next order to get a treat on us.' }
    : { ...blank, name: 'Birthday month', segment: 'BIRTHDAY_MONTH', subject: 'Happy birthday month!', body: 'Hi {{name}}, happy birthday month! Use code {{code}} on your next order.' }); setOpen(true); };
  const create = async (e: React.FormEvent) => {
    e.preventDefault(); setErr(null);
    try { await api('/campaigns', { body: { ...f, subject: f.channel === 'EMAIL' ? f.subject : undefined } }); setOpen(false); setF(blank); refresh(); toast('Draft saved'); } catch (x) { setErr(x); }
  };
  const send = async (c: any) => {
    if (!confirm(`Send “${c.name}” now? Only customers who agreed to marketing and haven’t opted out will receive it.`)) return;
    try { const r = await api<{ recipients: number }>(`/campaigns/${c.id}/send`, { body: {} }); toast(`Sending to ${r.recipients} customer${r.recipients > 1 ? 's' : ''}…`); refresh(); } catch (x) { toast(errMsg(x), 'err'); }
  };
  const anyChannel = channels.data && (channels.data.EMAIL || channels.data.WHATSAPP);
  return (
    <Page>
      <Title action={<div className="flex gap-2"><button className="btn-ghost" onClick={() => preset('winback')}>Win-back</button><button className="btn-ghost" onClick={() => preset('birthday')}>Birthday month</button><button className="btn-primary" onClick={() => { setF(blank); setOpen(true); }}>New campaign</button></div>}>Marketing</Title>
      {channels.data && !anyChannel && <div className="mb-4 rounded-xl bg-amber-50 p-3 text-sm text-amber-900" role="status">No sending service is connected on this server, so campaigns can be drafted but not sent. Add email (Resend) or WhatsApp Cloud API credentials to <code>apps/api/.env</code> — see the README.</div>}
      {channels.data && anyChannel && <p className="mb-4 text-sm text-stone-500">Connected: {channels.data.EMAIL ? `email (${channels.data.EMAIL})` : 'email not connected'} · {channels.data.WHATSAPP ? `WhatsApp (${channels.data.WHATSAPP})` : 'WhatsApp not connected'}</p>}
      {campaigns.isLoading ? <Skeleton className="h-40" /> : !campaigns.data?.length ? <Empty title="No campaigns yet" hint="Reach customers who agreed to hear from you, then see which orders came from it." /> : (
        <div className="space-y-3">{campaigns.data.map((c) => (
          <div key={c.id} className="card flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0"><p className="font-bold">{c.name} <span className="ml-1 rounded-full bg-stone-100 px-2 py-0.5 text-xs font-semibold">{c.status === 'DRAFT' ? 'Draft' : c.status === 'SENDING' ? 'Sending…' : 'Sent'}</span></p>
              <p className="text-sm text-stone-500">{c.channel === 'EMAIL' ? 'Email' : 'WhatsApp'} · {SEGMENTS.find((s) => s[0] === c.segment)?.[1]}{c.couponCode && ` · code ${c.couponCode}`}</p>
              {c.status !== 'DRAFT' && <p className="mt-1 text-sm">Sent {c.stats.sent}{c.stats.failed > 0 && <span className="text-red-600"> · failed {c.stats.failed}</span>}{c.stats.queued > 0 && ` · waiting ${c.stats.queued}`}{c.couponCode && <> · <b>{c.stats.orders}</b> order{c.stats.orders === 1 ? '' : 's'} using the code ({money(c.stats.revenueCents)})</>}</p>}</div>
            <div className="flex gap-2">
              {c.status === 'DRAFT' && <><button className="btn-primary px-3 py-1.5 text-xs" disabled={!channels.data?.[c.channel as 'EMAIL' | 'WHATSAPP']} onClick={() => send(c)}><Send size={14} /> Send</button>
                <button className="btn-ghost px-3 py-1.5 text-xs text-red-600" onClick={() => confirm('Delete this draft?') && api(`/campaigns/${c.id}`, { method: 'DELETE' }).then(refresh).catch((x) => toast(errMsg(x), 'err'))}>Delete</button></>}
              {c.status !== 'DRAFT' && <button className="btn-ghost px-3 py-1.5 text-xs" onClick={() => setView(c.id)}>Details</button>}
            </div>
          </div>))}</div>
      )}

      <Modal open={open} onClose={() => setOpen(false)} title="New campaign">
        <form onSubmit={create} className="space-y-3">
          <Field label="Name (for you)" error={fieldErrors(err, 'name')}><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Channel"><select className="input" value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value })}><option value="EMAIL">Email</option><option value="WHATSAPP">WhatsApp</option></select></Field>
            <Field label="Audience"><select className="input" value={f.segment} onChange={(e) => setF({ ...f, segment: e.target.value })}>{SEGMENTS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
          </div>
          {f.channel === 'EMAIL' && <Field label="Subject" error={fieldErrors(err, 'subject')}><input className="input" value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} /></Field>}
          <Field label="Message" error={fieldErrors(err, 'body')}><textarea className="input" rows={4} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} /></Field>
          <p className="text-xs text-stone-500">Use <code>{'{{name}}'}</code> for the first name and <code>{'{{code}}'}</code> for the coupon. An unsubscribe link is added automatically.{f.channel === 'WHATSAPP' && ' WhatsApp sends through your approved message template, so the text goes into its variable.'}</p>
          <Field label="Coupon to promote (also used to measure orders)" error={fieldErrors(err, 'couponCode')}><select className="input" value={f.couponCode} onChange={(e) => setF({ ...f, couponCode: e.target.value })}><option value="">None</option>{general.map((c) => <option key={c.id} value={c.code}>{c.code}</option>)}</select></Field>
          {!!err && !fieldErrors(err, 'name') && !fieldErrors(err, 'subject') && !fieldErrors(err, 'body') && !fieldErrors(err, 'couponCode') && <p className="err" role="alert">{errMsg(err)}</p>}
          <button className="btn-primary w-full" disabled={f.name.trim().length < 2 || f.body.trim().length < 5}>Save draft</button>
        </form>
      </Modal>
      <CampaignDetail id={view} onClose={() => setView(null)} />
    </Page>
  );
}

function CampaignDetail({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { data, isLoading } = useQuery({ queryKey: ['campaign', id], enabled: !!id, queryFn: () => api<any>(`/campaigns/${id}`) });
  return (
    <Modal open={!!id} onClose={onClose} title={data?.name ?? 'Campaign'}>
      {isLoading || !data ? <Skeleton /> : (
        <div className="space-y-2 text-sm">
          <p>Sent {data.stats.sent} · failed {data.stats.failed} · waiting {data.stats.queued}</p>
          <div className="max-h-72 overflow-y-auto divide-y divide-stone-100">{data.messages.map((m: any) => (
            <div key={m.id} className="flex justify-between gap-2 py-1.5"><span>{m.name}<span className="block text-xs text-stone-500">{m.recipient}</span></span>
              <span className={m.status === 'FAILED' ? 'text-right text-red-600' : m.status === 'SENT' ? 'text-green-700' : 'text-stone-500'}>{m.status.toLowerCase()}{m.error && <span className="block text-xs">{m.error}</span>}</span></div>))}</div>
        </div>
      )}
    </Modal>
  );
}
