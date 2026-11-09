import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Button, Card, ErrorState, Field, Input, useToast } from '@/components/ui';
import { api } from '@/lib/api';
import { useSeo } from '@/lib/hooks';

export default function ResetPassword() {
  useSeo('Reset password');
  const [sp] = useSearchParams();
  const nav = useNavigate();
  const toast = useToast();
  const [pw, setPw] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const token = sp.get('token');
  if (!token) return <div className="mx-auto max-w-md p-10"><ErrorState error={new Error('This reset link is missing its token.')} /><Link to="/admin/login" className="mt-3 inline-block underline">Back to sign-in</Link></div>;
  return (
    <div className="mx-auto max-w-md px-4 py-14">
      <h1 className="text-4xl">Choose a new password</h1>
      <Card className="mt-6 p-5">
        {!!error && <div className="mb-4"><ErrorState error={error} /></div>}
        <form className="space-y-4" onSubmit={async (e) => { e.preventDefault(); setBusy(true); setError(null); try { await api('/api/auth/reset-password', { body: { token, password: pw } }); toast('success', 'Password updated — please sign in'); nav('/admin/login'); } catch (err) { setError(err); } finally { setBusy(false); } }}>
          <Field label="New password" hint="10+ characters with upper and lower case letters and a number">{(id) => <Input id={id} type="password" required minLength={10} autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} />}</Field>
          <Button className="w-full" loading={busy}>Update password</Button>
        </form>
      </Card>
    </div>
  );
}
