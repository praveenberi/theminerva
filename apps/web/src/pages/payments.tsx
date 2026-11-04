import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, ShieldCheck } from 'lucide-react';
import { api, errMsg, fieldErrors, money } from '../lib';
import { Field, Skeleton, useToast } from '../ui';

const LABEL: Record<string, string> = { stripe: 'Stripe', razorpay: 'Razorpay', test: 'Test provider (development only)' };
const blank = { stripe: { secretKey: '', webhookSecret: '' }, razorpay: { keyId: '', keySecret: '', webhookSecret: '' }, test: {} } as Record<string, Record<string, string>>;
const FIELDS: Record<string, [string, string, string][]> = {
  stripe: [['secretKey', 'Secret key', 'sk_test_…'], ['webhookSecret', 'Webhook signing secret', 'whsec_…']],
  razorpay: [['keyId', 'Key Id', 'rzp_test_…'], ['keySecret', 'Key Secret', ''], ['webhookSecret', 'Webhook secret (you choose it)', '']],
  test: [],
};
const STEPS: Record<string, string> = {
  stripe: 'In Stripe: Developers → Webhooks → Add endpoint. Use your webhook URL (shown here once connected) and select the events checkout.session.completed and checkout.session.expired. Then copy the endpoint’s signing secret here.',
  razorpay: 'In Razorpay: Settings → Webhooks → Add. Use your webhook URL (shown here once connected), choose any secret (paste the same one here) and tick payment_link.paid, payment_link.expired and payment_link.cancelled.',
  test: 'The test provider needs no setup. Payments are simulated on a test page and no money moves.',
};

/** Owner-only: connect the restaurant's own payment provider account so customer payments go to its own money, not the platform's. */
export function PaymentsSettings({ onChanged }: { onChanged: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data, isLoading } = useQuery({ queryKey: ['payment-account'], queryFn: () => api<{ account: any; providers: string[] }>('/payment-account') });
  const pays = useQuery({ queryKey: ['payments'], queryFn: () => api<any>('/payments') });
  const [provider, setProvider] = useState('');
  const [vals, setVals] = useState<Record<string, string>>({});
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [replacing, setReplacing] = useState(false);
  if (isLoading || !data) return <Skeleton className="mt-6 h-40" />;
  const acct = data.account;
  const choice = provider || acct?.provider || data.providers[0];
  const showForm = !acct || replacing;
  const refresh = () => { qc.invalidateQueries({ queryKey: ['payment-account'] }); qc.invalidateQueries({ queryKey: ['restaurant'] }); onChanged(); };

  const connect = async (e: React.FormEvent) => {
    e.preventDefault(); setErr(null); setBusy(true);
    try { await api('/payment-account', { method: 'PUT', body: { provider: choice, secrets: vals } }); setVals({}); setReplacing(false); refresh(); toast('Payment account connected and verified'); } catch (x) { setErr(x); } finally { setBusy(false); }
  };
  const disconnect = async () => {
    if (!confirm('Disconnect this payment account? Online payment will stop being offered. Past payments can still be refunded.')) return;
    try { await api('/payment-account', { method: 'DELETE' }); refresh(); toast('Disconnected'); } catch (x) { toast(errMsg(x), 'err'); }
  };
  const generic = !!err && !Object.keys((err as any).details ?? {}).length;

  return (
    <section className="card mt-6">
      <h2 className="flex items-center gap-2 text-lg font-bold"><ShieldCheck size={20} className="text-brand-500" /> Online payments</h2>
      <p className="mt-1 text-sm text-stone-600">Connect your own payment provider account. Customers pay your account directly; this platform never holds your sales money. Your keys are encrypted and never shown again.</p>

      {acct && !replacing && (
        <div className="mt-4 space-y-3 text-sm">
          <p><b>{LABEL[acct.provider]}</b> <span className={`ml-1 rounded-full px-2 py-0.5 text-xs font-semibold ${acct.mode === 'live' ? 'bg-green-100 text-green-800' : 'bg-amber-100 text-amber-800'}`}>{acct.mode} mode</span> · key {acct.keyHint} · verified {acct.verifiedAt ? new Date(acct.verifiedAt).toLocaleDateString() : ''}</p>
          <div><p className="label">Webhook URL (paste into your provider)</p>
            <div className="flex gap-2"><input className="input font-mono text-xs" readOnly value={acct.webhookUrl} aria-label="Webhook URL" onFocus={(e) => e.currentTarget.select()} />
              <button type="button" className="btn-ghost" onClick={() => navigator.clipboard?.writeText(acct.webhookUrl).then(() => toast('Copied'))} aria-label="Copy webhook URL"><Copy size={16} /></button></div>
            <p className="mt-1 text-xs text-stone-500">{STEPS[acct.provider]}</p></div>
          <div className="flex gap-2"><button className="btn-ghost" onClick={() => { setReplacing(true); setProvider(acct.provider); }}>Replace credentials</button><button className="btn-ghost text-red-600" onClick={disconnect}>Disconnect</button></div>
        </div>
      )}

      {showForm && (
        <form onSubmit={connect} className="mt-4 space-y-3">
          <Field label="Provider"><select className="input" value={choice} onChange={(e) => { setProvider(e.target.value); setVals({}); setErr(null); }}>{data.providers.map((p) => <option key={p} value={p}>{LABEL[p]}</option>)}</select></Field>
          {FIELDS[choice].map(([k, l, ph]) => <Field key={k} label={l} error={fieldErrors(err, k)}><input className="input font-mono text-sm" type="password" autoComplete="off" placeholder={ph} value={vals[k] ?? ''} onChange={(e) => setVals({ ...vals, [k]: e.target.value })} /></Field>)}
          <p className="text-xs text-stone-500">{STEPS[choice]} The webhook URL appears after you connect. Use your <b>test</b> keys while setting up.</p>
          {generic && <p className="err" role="alert">{errMsg(err)}</p>}
          <div className="flex gap-2"><button className="btn-primary" disabled={busy || FIELDS[choice].some(([k]) => !vals[k])}>{busy ? 'Checking with provider…' : 'Verify and connect'}</button>{replacing && <button type="button" className="btn-ghost" onClick={() => { setReplacing(false); setErr(null); }}>Cancel</button>}</div>
        </form>
      )}

      {pays.data && pays.data.payments.length > 0 && (
        <div className="mt-6">
          <h3 className="mb-2 font-bold">Recent online payments</h3>
          <p className="mb-2 text-sm text-stone-600">Collected {money(pays.data.summary.collectedCents)} · refunded {money(pays.data.summary.refundedCents)}{pays.data.summary.pending > 0 && ` · ${pays.data.summary.pending} pending`}{pays.data.summary.failed > 0 && ` · ${pays.data.summary.failed} failed`}</p>
          <div className="overflow-x-auto rounded-xl ring-1 ring-stone-200"><table className="w-full text-left text-sm">
            <thead className="bg-stone-50 text-xs uppercase text-stone-500"><tr>{['Order', 'Customer', 'Amount', 'Status', 'Refunded', 'Date'].map((h) => <th key={h} className="px-3 py-2">{h}</th>)}</tr></thead>
            <tbody>{pays.data.payments.slice(0, 10).map((p: any) => <tr key={p.id} className="border-t border-stone-100"><td className="px-3 py-2 font-semibold">#{p.orderNumber}</td><td className="px-3 py-2">{p.customer}</td><td className="px-3 py-2">{money(p.amountCents, p.currency)}</td><td className="px-3 py-2">{p.status.toLowerCase()}</td><td className="px-3 py-2">{p.refundedCents ? money(p.refundedCents, p.currency) : '—'}</td><td className="px-3 py-2">{new Date(p.paidAt ?? p.createdAt).toLocaleDateString()}</td></tr>)}</tbody></table></div>
        </div>
      )}
    </section>
  );
}
