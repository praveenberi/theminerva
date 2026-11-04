import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ChefHat } from 'lucide-react';
import { api, errMsg, fieldErrors } from '../lib';
import { Field } from '../ui';

function Shell({ title, children, footer }: { title: string; children: React.ReactNode; footer?: React.ReactNode }) {
  return (
    <div className="grid min-h-screen place-items-center px-4">
      <div className="w-full max-w-md">
        <Link to="/" className="mb-6 flex items-center justify-center gap-2 text-xl font-extrabold"><ChefHat className="text-brand-500" /> Tablely</Link>
        <div className="card p-7"><h1 className="mb-5 text-2xl font-bold">{title}</h1>{children}</div>
        {footer && <p className="mt-4 text-center text-sm text-stone-600">{footer}</p>}
      </div>
    </div>
  );
}

export function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [state, setState] = useState<'idle' | 'busy' | 'sent'>('idle');
  const [error, setError] = useState('');
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setError(''); setState('busy');
    try { await api('/auth/forgot-password', { body: { email } }); setState('sent'); } catch (x) { setError(errMsg(x)); setState('idle'); }
  };
  return (
    <Shell title="Reset your password" footer={<Link className="font-semibold text-brand-600" to="/login">Back to log in</Link>}>
      {state === 'sent' ? (
        <div className="space-y-2 text-sm" role="status">
          <p className="font-semibold">Check your email.</p>
          <p className="text-stone-600">If <b>{email}</b> has an account, we’ve sent a link to choose a new password. It works once and expires in 30 minutes. No email? Check spam, or try again in a few minutes.</p>
        </div>
      ) : (
        <form className="space-y-4" onSubmit={submit}>
          <p className="text-sm text-stone-600">Enter the email you signed up with and we’ll send you a link.</p>
          <Field label="Email"><input className="input" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          {error && <p className="err" role="alert">{error}</p>}
          <button className="btn-primary w-full" disabled={state === 'busy' || !email.includes('@')}>{state === 'busy' ? 'Sending…' : 'Send reset link'}</button>
        </form>
      )}
    </Shell>
  );
}

/** Pulls the one-time token out of the address bar immediately, so it doesn't linger in history or leak through a Referer header. */
function useUrlToken() {
  const [sp] = useSearchParams();
  const [token] = useState(() => sp.get('token') ?? '');
  useEffect(() => { if (sp.get('token')) window.history.replaceState(null, '', window.location.pathname); }, [sp]);
  return token;
}

export function ResetPassword() {
  const token = useUrlToken();
  const nav = useNavigate();
  const [f, setF] = useState({ password: '', again: '' });
  const [err, setErr] = useState<unknown>(null);
  const [done, setDone] = useState<{ mfaRequired: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const mismatch = f.again !== '' && f.password !== f.again;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr(null); setBusy(true);
    try { setDone(await api('/auth/reset-password', { body: { token, password: f.password } })); } catch (x) { setErr(x); } finally { setBusy(false); }
  };
  if (!token) return <Shell title="Link missing" footer={<Link className="font-semibold text-brand-600" to="/forgot-password">Request a new link</Link>}><p className="text-sm text-stone-600">This page needs the link from your email. Open the link again, or request a new one.</p></Shell>;
  if (done) return (
    <Shell title="Password changed">
      <p className="text-sm text-stone-600" role="status">Your password has been changed and you’ve been signed out everywhere.{done.mfaRequired && ' You’ll still need your authenticator code to sign in.'}</p>
      <button className="btn-primary mt-5 w-full" onClick={() => nav('/login', { replace: true })}>Go to log in</button>
    </Shell>
  );
  return (
    <Shell title="Choose a new password">
      <form className="space-y-4" onSubmit={submit}>
        <Field label="New password" error={fieldErrors(err, 'password')}><input className="input" type="password" autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>
        <Field label="New password again" error={mismatch ? 'The passwords do not match' : undefined}><input className="input" type="password" autoComplete="new-password" value={f.again} onChange={(e) => setF({ ...f, again: e.target.value })} /></Field>
        <p className="text-xs text-stone-500">At least 10 characters, not a common password.</p>
        {!!err && !fieldErrors(err, 'password') && (
          <p className="err" role="alert">{errMsg(err)} {(err as any)?.code === 'invalid_token' && <Link className="font-semibold underline" to="/forgot-password">Request a new link</Link>}</p>
        )}
        <button className="btn-primary w-full" disabled={busy || f.password.length < 10 || f.password !== f.again}>{busy ? 'Saving…' : 'Change password'}</button>
      </form>
    </Shell>
  );
}

export function VerifyEmail() {
  const token = useUrlToken();
  const [state, setState] = useState<'working' | 'ok' | 'bad'>('working');
  const [msg, setMsg] = useState('');
  useEffect(() => {
    if (!token) { setState('bad'); setMsg('This page needs the link from your email.'); return; }
    api('/auth/verify-email', { body: { token } }).then(() => setState('ok')).catch((e) => { setState('bad'); setMsg(errMsg(e)); });
  }, [token]);
  return (
    <Shell title={state === 'ok' ? 'Email confirmed' : state === 'bad' ? 'Couldn’t confirm' : 'Confirming…'} footer={<Link className="font-semibold text-brand-600" to="/app">Go to your dashboard</Link>}>
      {state === 'ok' && <p className="text-sm text-stone-600" role="status">Thanks, your email address is confirmed.</p>}
      {state === 'bad' && <p className="err" role="alert">{msg} Sign in and use “Resend” under Account to get a fresh link.</p>}
    </Shell>
  );
}
