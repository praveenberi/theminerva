import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';
import { api, errMsg, fieldErrors } from '../lib';
import { Empty, Field, Modal, Page, Skeleton, useToast } from '../ui';

interface Ing { id: string; name: string; unit: string; stockQty: number; lowThreshold: number; low: boolean; expiresAt: string | null; supplier: string | null; supplierId: string | null }
const fmt = (n: number) => String(Math.round(n * 1000) / 1000);

export function InventoryPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const ings = useQuery({ queryKey: ['ingredients'], queryFn: () => api<Ing[]>('/ingredients') });
  const sups = useQuery({ queryKey: ['suppliers'], queryFn: () => api<any[]>('/suppliers') });
  const [f, setF] = useState({ name: '', unit: 'kg', lowThreshold: 0, supplierId: '' });
  const [err, setErr] = useState<unknown>(null);
  const [adjust, setAdjust] = useState<{ ing: Ing; type: 'PURCHASE' | 'WASTAGE' | 'COUNT' } | null>(null);
  const [history, setHistory] = useState<Ing | null>(null);
  const [supName, setSupName] = useState('');
  const refresh = () => { qc.invalidateQueries({ queryKey: ['ingredients'] }); qc.invalidateQueries({ queryKey: ['dash'] }); };

  const add = async (e: React.FormEvent) => {
    e.preventDefault(); setErr(null);
    try { await api('/ingredients', { body: { ...f, supplierId: f.supplierId || null } }); setF({ ...f, name: '' }); refresh(); toast('Ingredient added'); } catch (x) { setErr(x); }
  };
  const low = (ings.data ?? []).filter((i) => i.low);

  return (
    <Page>
      <h1 className="mb-5 text-2xl font-extrabold">Inventory</h1>
      {low.length > 0 && (
        <div className="mb-4 flex items-start gap-2 rounded-xl bg-amber-50 p-3 text-sm text-amber-900" role="status">
          <AlertTriangle size={18} className="mt-0.5 shrink-0" /><span><b>Low stock:</b> {low.map((i) => `${i.name} (${fmt(i.stockQty)} ${i.unit})`).join(', ')}</span>
        </div>
      )}
      <form onSubmit={add} className="card mb-4 grid gap-3 sm:grid-cols-5">
        <Field label="Ingredient" error={(err as any)?.status === 409 ? errMsg(err) : fieldErrors(err, 'name')}><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Unit"><input className="input" value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })} placeholder="kg, l, pcs" /></Field>
        <Field label="Alert at or below"><input className="input" type="number" min={0} step="any" value={f.lowThreshold} onChange={(e) => setF({ ...f, lowThreshold: Number(e.target.value) })} /></Field>
        <Field label="Supplier"><select className="input" value={f.supplierId} onChange={(e) => setF({ ...f, supplierId: e.target.value })}><option value="">—</option>{sups.data?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
        <div className="self-end"><button className="btn-primary w-full" disabled={!f.name.trim() || !f.unit.trim()}>Add ingredient</button></div>
      </form>

      {ings.isLoading ? <Skeleton className="h-40" /> : !ings.data?.length ? <Empty title="No ingredients yet" hint="Add ingredients, set a recipe on each menu item, and stock is deducted automatically when orders complete." /> : (
        <div className="card overflow-x-auto p-0"><table className="w-full text-left text-sm">
          <thead className="bg-stone-50 text-xs uppercase text-stone-500"><tr>{['Ingredient', 'In stock', 'Alert at', 'Supplier', 'Expires', ''].map((h) => <th key={h} className="px-4 py-3">{h}</th>)}</tr></thead>
          <tbody>{ings.data.map((i) => (
            <tr key={i.id} className="border-t border-stone-100">
              <td className="px-4 py-3 font-semibold">{i.name}</td>
              <td className={`px-4 py-3 ${i.low ? 'font-bold text-red-600' : ''}`}>{fmt(i.stockQty)} {i.unit}{i.low && ' · low'}</td>
              <td className="px-4 py-3">{fmt(i.lowThreshold)}</td><td className="px-4 py-3">{i.supplier ?? '—'}</td>
              <td className="px-4 py-3">{i.expiresAt ? new Date(i.expiresAt).toLocaleDateString() : '—'}</td>
              <td className="space-x-1 whitespace-nowrap px-4 py-3 text-right">
                <button className="btn-ghost px-2 py-1 text-xs" onClick={() => setAdjust({ ing: i, type: 'PURCHASE' })}>Receive</button>
                <button className="btn-ghost px-2 py-1 text-xs" onClick={() => setAdjust({ ing: i, type: 'WASTAGE' })}>Waste</button>
                <button className="btn-ghost px-2 py-1 text-xs" onClick={() => setAdjust({ ing: i, type: 'COUNT' })}>Count</button>
                <button className="btn-ghost px-2 py-1 text-xs" onClick={() => setHistory(i)}>History</button>
                <button className="btn-ghost px-2 py-1 text-xs text-red-600" onClick={() => confirm(`Delete ${i.name}? Recipes using it will lose this line.`) && api(`/ingredients/${i.id}`, { method: 'DELETE' }).then(refresh).catch((e) => toast(errMsg(e), 'err'))}>Delete</button>
              </td>
            </tr>))}</tbody></table></div>
      )}

      <h2 className="mb-2 mt-8 text-lg font-bold">Suppliers</h2>
      <form className="mb-3 flex gap-2" onSubmit={async (e) => { e.preventDefault(); try { await api('/suppliers', { body: { name: supName } }); setSupName(''); qc.invalidateQueries({ queryKey: ['suppliers'] }); } catch (x) { toast(errMsg(x), 'err'); } }}>
        <input className="input max-w-xs" placeholder="Supplier name" value={supName} onChange={(e) => setSupName(e.target.value)} aria-label="Supplier name" /><button className="btn-ghost" disabled={!supName.trim()}>Add supplier</button>
      </form>
      <div className="flex flex-wrap gap-2">{sups.data?.map((s) => <span key={s.id} className="rounded-full bg-white px-3 py-1 text-sm ring-1 ring-stone-200">{s.name} <button aria-label={`Delete ${s.name}`} className="ml-1 text-stone-400 hover:text-red-600" onClick={() => api(`/suppliers/${s.id}`, { method: 'DELETE' }).then(() => { qc.invalidateQueries({ queryKey: ['suppliers'] }); refresh(); })}>×</button></span>)}</div>

      <AdjustModal state={adjust} onClose={() => setAdjust(null)} onDone={() => { setAdjust(null); refresh(); toast('Stock updated'); }} />
      <HistoryModal ing={history} onClose={() => setHistory(null)} />
    </Page>
  );
}

function AdjustModal({ state, onClose, onDone }: { state: { ing: Ing; type: 'PURCHASE' | 'WASTAGE' | 'COUNT' } | null; onClose: () => void; onDone: () => void }) {
  const [v, setV] = useState('');
  const [note, setNote] = useState('');
  const [exp, setExp] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  if (!state) return <Modal open={false} onClose={onClose} title="">{null}</Modal>;
  const { ing, type } = state;
  const title = { PURCHASE: `Receive stock: ${ing.name}`, WASTAGE: `Record wastage: ${ing.name}`, COUNT: `Stock count: ${ing.name}` }[type];
  const submit = async () => {
    setBusy(true); setError('');
    const n = Number(v);
    const body = type === 'COUNT' ? { type, counted: n, note: note || undefined } : { type, qty: n, note: note || undefined, ...(type === 'PURCHASE' && exp ? { expiresAt: new Date(exp).toISOString() } : {}) };
    try { await api(`/ingredients/${ing.id}/stock`, { body }); setV(''); setNote(''); setExp(''); onDone(); } catch (e) { setError(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title={title}>
      <div className="space-y-3">
        {type === 'COUNT' && <p className="text-sm text-stone-600">System says <b>{fmt(ing.stockQty)} {ing.unit}</b>. Enter what you actually counted; the difference is recorded as an adjustment.</p>}
        <Field label={type === 'COUNT' ? `Counted (${ing.unit})` : `Quantity (${ing.unit})`}><input className="input" type="number" min={0} step="any" value={v} onChange={(e) => setV(e.target.value)} autoFocus /></Field>
        {type === 'PURCHASE' && <Field label="Expiry date (optional)"><input className="input" type="date" value={exp} onChange={(e) => setExp(e.target.value)} /></Field>}
        <Field label="Note"><input className="input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} placeholder={type === 'WASTAGE' ? 'e.g. spoiled, dropped' : ''} /></Field>
        {error && <p className="err" role="alert">{error}</p>}
        <button className="btn-primary w-full" disabled={busy || v === '' || Number(v) < 0 || (type !== 'COUNT' && Number(v) <= 0)} onClick={submit}>{busy ? 'Saving…' : 'Save'}</button>
      </div>
    </Modal>
  );
}

function HistoryModal({ ing, onClose }: { ing: Ing | null; onClose: () => void }) {
  const { data, isLoading } = useQuery({ queryKey: ['movements', ing?.id], enabled: !!ing, queryFn: () => api<any[]>(`/ingredients/${ing!.id}/movements`) });
  return (
    <Modal open={!!ing} onClose={onClose} title={`History: ${ing?.name ?? ''}`}>
      {isLoading ? <Skeleton /> : !data?.length ? <p className="text-sm text-stone-500">No movements yet.</p> : (
        <ul className="divide-y divide-stone-100 text-sm">{data.map((m) => (
          <li key={m.id} className="flex justify-between gap-3 py-2"><span><b>{m.reason.toLowerCase()}</b>{m.note && <span className="text-stone-500"> · {m.note}</span>}<br /><span className="text-xs text-stone-400">{new Date(m.createdAt).toLocaleString()}</span></span>
            <span className={m.delta < 0 ? 'text-red-600' : 'text-green-700'}>{m.delta > 0 ? '+' : ''}{fmt(m.delta)} {ing?.unit}</span></li>))}</ul>
      )}
    </Modal>
  );
}

export function RecipeModal({ product, onClose }: { product: { id: string; name: string } | null; onClose: () => void }) {
  const toast = useToast();
  const ings = useQuery({ queryKey: ['ingredients'], queryFn: () => api<Ing[]>('/ingredients'), enabled: !!product });
  const [rows, setRows] = useState<{ ingredientId: string; qty: number }[] | null>(null);
  const id = product?.id;
  useEffect(() => {
    if (!id) return;
    let live = true;
    setRows(null);
    api<any[]>(`/products/${id}/recipe`).then((r) => live && setRows(r.map((x) => ({ ingredientId: x.ingredientId, qty: x.qty })))).catch((e) => toast(errMsg(e), 'err'));
    return () => { live = false; };
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  const used = new Set(rows?.map((r) => r.ingredientId));
  const unit = (id: string) => ings.data?.find((i) => i.id === id)?.unit ?? '';
  const save = async () => {
    try { await api(`/products/${product!.id}/recipe`, { method: 'PUT', body: { items: rows!.filter((r) => r.qty > 0) } }); toast('Recipe saved'); onClose(); } catch (e) { toast(errMsg(e), 'err'); }
  };
  return (
    <Modal open={!!product} onClose={onClose} title={`Recipe: ${product?.name ?? ''}`}>
      {rows === null || ings.isLoading ? <Skeleton /> : !ings.data?.length ? <p className="text-sm text-stone-600">Add ingredients in Inventory first.</p> : (
        <div className="space-y-2">
          <p className="text-sm text-stone-600">Amount of each ingredient used per portion. Deducted when an order is completed.</p>
          {rows.map((r, i) => (
            <div key={r.ingredientId} className="flex items-center gap-2">
              <select className="input" value={r.ingredientId} onChange={(e) => setRows(rows.map((x, j) => j === i ? { ...x, ingredientId: e.target.value } : x))} aria-label="Ingredient">{ings.data!.filter((g) => g.id === r.ingredientId || !used.has(g.id)).map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}</select>
              <input className="input w-28" type="number" min={0} step="any" value={r.qty} onChange={(e) => setRows(rows.map((x, j) => j === i ? { ...x, qty: Number(e.target.value) } : x))} aria-label="Quantity per portion" />
              <span className="w-8 text-xs text-stone-500">{unit(r.ingredientId)}</span>
              <button className="btn-ghost px-3" aria-label="Remove" onClick={() => setRows(rows.filter((_, j) => j !== i))}>×</button>
            </div>))}
          {ings.data.some((g) => !used.has(g.id)) && <button className="btn-ghost px-3 py-1.5 text-xs" onClick={() => setRows([...rows, { ingredientId: ings.data!.find((g) => !used.has(g.id))!.id, qty: 0 }])}>+ Add ingredient</button>}
          <button className="btn-primary mt-2 w-full" onClick={save}>Save recipe</button>
        </div>
      )}
    </Modal>
  );
}
