import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { MailCheck, ShieldCheck } from 'lucide-react';
import { api, errMsg, fieldErrors, setToken, useAuth } from '../lib';
import { Field, Page, Skeleton, useToast } from '../ui';

interface MeInfo { emailVerified: boolean; mfaEnabled: boolean; recoveryCodesLeft: number; email: string }
export const useMeInfo = () => useQuery({ queryKey: ['me-info'], queryFn: () => api<MeInfo>('/auth/me'), staleTime: 30_000 });

/** Strip above the dashboard until the owner has confirmed their email address. */
export function EmailBanner() {
  const { me } = useAuth();
  const toast = useToast();
  const { data } = useMeInfo();
  const [sent, setSent] = useState(false);
  if (!data || data.emailVerified || me!.role !== 'OWNER') return null;
  return (
    <div className="flex flex-wrap items-center gap-3 bg-amber-100 px-4 py-2 text-sm text-amber-900" role="status">
      <MailCheck size={16} /> Please confirm your email address ({data.email}). Sending campaigns and connecting a payment account need it.
      <button className="font-bold underline disabled:opacity-60" disabled={sent} onClick={() => api('/auth/verify-email/request', { body: {} }).then(() => { setSent(true); toast('Confirmation email sent'); }).catch((e) => toast(errMsg(e), 'err'))}>{sent ? 'Sent. Check your inbox' : 'Resend the email'}</button>
    </div>
  );
}

const svgUrl = (svg: string) => `data:image/svg+xml;base64,${btoa(svg)}`;

function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const toast = useToast();
  const [saved, setSaved] = useState(false);
  const text = `Tablely recovery codes\nEach works once. Keep them somewhere safe and private.\n\n${codes.join('\n')}\n`;
  return (
    <div className="space-y-3">
      <p className="text-sm font-semibold">Save your recovery codes now. They won’t be shown again.</p>
      <p className="text-sm text-stone-600">If you lose your phone, each code lets you sign in once. Store them in a password manager or print them.</p>
      <div className="grid grid-cols-2 gap-2 rounded-xl bg-stone-100 p-3 font-mono text-sm" aria-label="Recovery codes">{codes.map((c) => <span key={c}>{c}</span>)}</div>
      <div className="flex gap-2">
        <button type="button" className="btn-ghost" onClick={() => navigator.clipboard?.writeText(text).then(() => toast('Copied'))}>Copy</button>
        <a className="btn-ghost" href={URL.createObjectURL(new Blob([text], { type: 'text/plain' }))} download="tablely-recovery-codes.txt">Download</a>
      </div>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} /> I’ve saved these codes</label>
      <button className="btn-primary" disabled={!saved} onClick={onDone}>Done</button>
    </div>
  );
}

/** Email confirmation status and two-step verification, shared by the Account page and the platform admin page. */
export function SecuritySection({ intro }: { intro?: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data, isLoading } = useMeInfo();
  const [step, setStep] = useState<'idle' | 'password' | 'scan' | 'codes' | 'regen' | 'off'>('idle');
  const [pw, setPw] = useState('');
  const [code, setCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const [setup, setSetup] = useState<{ secret: string; qrSvg: string } | null>(null);
  const [codes, setCodes] = useState<string[]>([]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  if (isLoading || !data) return <Skeleton className="h-40" />;

  const reset = () => { setStep('idle'); setPw(''); setCode(''); setErr(''); setSetup(null); setUseRecovery(false); };
  const refresh = () => qc.invalidateQueries(); // everything: enabling MFA can unlock pages that were refusing to load (platform admin)
  const run = async (fn: () => Promise<void>) => { setBusy(true); setErr(''); try { await fn(); } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); } };

  const begin = () => run(async () => { setSetup(await api('/auth/mfa/setup', { body: { password: pw } })); setPw(''); setStep('scan'); });
  const enable = () => run(async () => {
    const r = await api<{ recoveryCodes: string[]; accessToken: string }>('/auth/mfa/enable', { body: { code } });
    setToken(r.accessToken); // turning MFA on ends other sessions; this one continues with a fresh token
    setCodes(r.recoveryCodes); setSetup(null); setCode(''); setStep('codes'); refresh();
  });
  const regen = () => run(async () => { const r = await api<{ recoveryCodes: string[] }>('/auth/mfa/recovery-codes', { body: { password: pw, code } }); setCodes(r.recoveryCodes); setPw(''); setCode(''); setStep('codes'); refresh(); });
  const turnOff = () => run(async () => {
    const r = await api<{ accessToken: string }>('/auth/mfa/disable', { body: { password: pw, ...(useRecovery ? { recoveryCode: code } : { code }) } });
    setToken(r.accessToken); reset(); refresh(); toast('Two-step verification is off');
  });

  return (
    <section className="card max-w-md">
      <h2 className="flex items-center gap-2 font-bold"><ShieldCheck size={18} className="text-brand-500" /> Security</h2>
      {intro && <p className="mt-1 text-sm text-stone-600">{intro}</p>}

      <div className="mt-4 flex items-center justify-between gap-3 text-sm">
        <span>Email address <b>{data.email}</b></span>
        {data.emailVerified ? <span className="rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-semibold text-green-800">Confirmed</span>
          : <button className="btn-ghost px-3 py-1.5 text-xs" onClick={() => api('/auth/verify-email/request', { body: {} }).then(() => toast('Confirmation email sent')).catch((e) => toast(errMsg(e), 'err'))}>Resend confirmation</button>}
      </div>

      <div className="mt-5 border-t border-stone-100 pt-4">
        <div className="flex items-center justify-between gap-3">
          <div><p className="font-semibold">Two-step verification</p><p className="text-sm text-stone-600">{data.mfaEnabled ? `On. ${data.recoveryCodesLeft} recovery code${data.recoveryCodesLeft === 1 ? '' : 's'} left.` : 'Asks for a code from an app on your phone when you sign in.'}</p></div>
          {step === 'idle' && (data.mfaEnabled ? <span className="rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-semibold text-green-800">On</span> : <button className="btn-primary px-3 py-1.5 text-xs" onClick={() => setStep('password')}>Turn on</button>)}
        </div>
        {data.mfaEnabled && step === 'idle' && data.recoveryCodesLeft <= 2 && <p className="mt-2 rounded-lg bg-amber-50 p-2 text-sm text-amber-900" role="status">You’re running low on recovery codes. Get a new set.</p>}

        {step === 'password' && (
          <form className="mt-3 space-y-3" onSubmit={(e) => { e.preventDefault(); begin(); }}>
            <Field label="Confirm your password to continue"><input className="input" type="password" autoComplete="current-password" autoFocus value={pw} onChange={(e) => setPw(e.target.value)} /></Field>
            {err && <p className="err" role="alert">{err}</p>}
            <div className="flex gap-2"><button className="btn-primary" disabled={busy || !pw}>{busy ? 'Working…' : 'Continue'}</button><button type="button" className="btn-ghost" onClick={reset}>Cancel</button></div>
          </form>
        )}

        {step === 'scan' && setup && (
          <form className="mt-3 space-y-3" onSubmit={(e) => { e.preventDefault(); enable(); }}>
            <ol className="list-decimal space-y-1 pl-5 text-sm text-stone-700"><li>Open an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password, Authy…).</li><li>Scan this code, or type the key by hand.</li><li>Enter the 6-digit code it shows.</li></ol>
            <img className="mx-auto h-44 w-44 rounded-lg ring-1 ring-stone-200" alt="QR code to scan with your authenticator app" src={svgUrl(setup.qrSvg)} />
            <p className="break-all text-center font-mono text-xs text-stone-600" aria-label="Setup key">{setup.secret.replace(/(.{4})/g, '$1 ').trim()}</p>
            <Field label="6-digit code"><input className="input tracking-widest" inputMode="numeric" autoComplete="one-time-code" maxLength={7} value={code} onChange={(e) => setCode(e.target.value)} /></Field>
            {err && <p className="err" role="alert">{err}</p>}
            <div className="flex gap-2"><button className="btn-primary" disabled={busy || code.replace(/\s/g, '').length < 6}>{busy ? 'Checking…' : 'Turn on'}</button><button type="button" className="btn-ghost" onClick={reset}>Cancel</button></div>
          </form>
        )}

        {step === 'codes' && <div className="mt-3"><RecoveryCodes codes={codes} onDone={reset} /></div>}

        {data.mfaEnabled && step === 'idle' && (
          <div className="mt-3 flex gap-2"><button className="btn-ghost px-3 py-1.5 text-xs" onClick={() => setStep('regen')}>New recovery codes</button><button className="btn-ghost px-3 py-1.5 text-xs text-red-600" onClick={() => setStep('off')}>Turn off</button></div>
        )}

        {(step === 'regen' || step === 'off') && (
          <form className="mt-3 space-y-3" onSubmit={(e) => { e.preventDefault(); (step === 'regen' ? regen : turnOff)(); }}>
            <p className="text-sm text-stone-600">{step === 'regen' ? 'This replaces your old recovery codes.' : 'Anyone with your password will be able to sign in without a code.'}</p>
            <Field label="Password"><input className="input" type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} /></Field>
            <Field label={useRecovery ? 'Recovery code' : 'Code from your authenticator app'}><input className="input tracking-widest" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} /></Field>
            {step === 'off' && <button type="button" className="text-sm font-semibold text-brand-600" onClick={() => { setUseRecovery(!useRecovery); setCode(''); }}>{useRecovery ? 'Use my authenticator app' : 'Use a recovery code instead'}</button>}
            <p className="text-xs text-stone-500">If you just used a code to sign in, wait for the next one: each code works once.</p>
            {err && <p className="err" role="alert">{err}</p>}
            <div className="flex gap-2"><button className={step === 'off' ? 'btn-danger' : 'btn-primary'} disabled={busy || !pw || !code}>{busy ? 'Working…' : step === 'off' ? 'Turn off' : 'Get new codes'}</button><button type="button" className="btn-ghost" onClick={reset}>Cancel</button></div>
          </form>
        )}
      </div>
    </section>
  );
}

export function AccountPage() {
  const { me } = useAuth();
  const toast = useToast();
  const [f, setF] = useState({ current: '', next: '', again: '' });
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const mismatch = f.again !== '' && f.next !== f.again;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr(null); setBusy(true);
    try {
      const r = await api<{ accessToken: string }>('/auth/change-password', { body: { current: f.current, next: f.next } });
      setToken(r.accessToken); // this device stays signed in; every other device is signed out
      setF({ current: '', next: '', again: '' });
      toast('Password changed. Other devices have been signed out.');
    } catch (x) { setErr(x); } finally { setBusy(false); }
  };

  return (
    <Page>
      <h1 className="mb-5 text-2xl font-extrabold">Account</h1>
      <div className="space-y-5">
        <section className="card max-w-md">
          <p className="text-sm text-stone-600">Signed in as <b>{me!.name}</b> ({me!.email}).</p>
          <h2 className="mb-3 mt-5 font-bold">Change password</h2>
          <form onSubmit={submit} className="space-y-3">
            <Field label="Current password"><input className="input" type="password" autoComplete="current-password" value={f.current} onChange={(e) => setF({ ...f, current: e.target.value })} /></Field>
            <Field label="New password" error={fieldErrors(err, 'next')}><input className="input" type="password" autoComplete="new-password" value={f.next} onChange={(e) => setF({ ...f, next: e.target.value })} /></Field>
            <Field label="New password again" error={mismatch ? 'The passwords do not match' : undefined}><input className="input" type="password" autoComplete="new-password" value={f.again} onChange={(e) => setF({ ...f, again: e.target.value })} /></Field>
            <p className="text-xs text-stone-500">At least 10 characters, not a common password. Changing it signs you out on every other device.</p>
            {!!err && !fieldErrors(err, 'next') && <p className="err" role="alert">{errMsg(err)}</p>}
            <button className="btn-primary" disabled={busy || !f.current || f.next.length < 10 || f.next !== f.again}>{busy ? 'Changing…' : 'Change password'}</button>
          </form>
        </section>
        <SecuritySection />
      </div>
    </Page>
  );
}
