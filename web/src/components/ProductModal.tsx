import { useMemo, useState } from 'react';
import { Minus, Plus } from 'lucide-react';
import { Button, Modal, Textarea, useToast } from '@/components/ui';
import { DietBadges, FoodImage } from '@/components/Food';
import { useCart } from '@/lib/cart';
import { money } from '@/lib/format';

export function ProductOptions({ p, onDone }: { p: any; onDone: () => void }) {
  const { dispatch } = useCart();
  const toast = useToast();
  const [variantId, setVariantId] = useState<string | undefined>(p.variants?.length === 1 ? p.variants[0].id : undefined);
  const [chosen, setChosen] = useState<Record<string, string[]>>({});
  const [qty, setQty] = useState(1);
  const [notes, setNotes] = useState('');
  const [error, setError] = useState('');

  const base = Number(p.discountPrice ?? p.price);
  const variant = p.variants?.find((v: any) => v.id === variantId);
  const addons = useMemo(() => p.addonGroups.flatMap((g: any) => g.addons.filter((a: any) => chosen[g.id]?.includes(a.id))), [p, chosen]);
  const unit = base + Number(variant?.priceDelta ?? 0) + addons.reduce((a: number, x: any) => a + Number(x.price), 0);

  const toggle = (g: any, id: string) => setChosen((c) => {
    const cur = c[g.id] ?? [];
    if (cur.includes(id)) return { ...c, [g.id]: cur.filter((x) => x !== id) };
    if (g.maxSelect === 1) return { ...c, [g.id]: [id] };
    return cur.length >= g.maxSelect ? c : { ...c, [g.id]: [...cur, id] };
  });

  const submit = () => {
    if (p.variants?.length && !variantId) return setError('Please choose a size');
    for (const g of p.addonGroups) if ((chosen[g.id]?.length ?? 0) < g.minSelect) return setError(`Choose at least ${g.minSelect} for “${g.name}”`);
    dispatch({
      t: 'add',
      line: { productId: p.id, name: p.name, slug: p.slug, imageUrl: p.images?.[0]?.url, variantId, variantName: variant?.name, addonIds: addons.map((a: any) => a.id), addonNames: addons.map((a: any) => a.name), unitPrice: unit, quantity: qty, notes: notes.trim() || undefined },
    });
    toast('success', `${p.name} added to your order`);
    onDone();
  };

  return (
    <div className="space-y-5">
      <div className="flex gap-4">
        <FoodImage src={p.images?.[0]?.url} name={p.name} className="h-24 w-24 shrink-0 rounded-xl" />
        <div>
          {p.description && <p className="text-sm text-muted">{p.description}</p>}
          <div className="mt-2"><DietBadges p={p} /></div>
        </div>
      </div>

      {!!p.variants?.length && (
        <fieldset>
          <legend className="mb-2 text-sm font-medium">Size <span className="text-danger">*</span></legend>
          <div className="grid gap-2">
            {p.variants.map((v: any) => (
              <label key={v.id} className="flex cursor-pointer items-center justify-between rounded-xl border border-border p-3 has-[:checked]:border-accent has-[:checked]:bg-accent/10">
                <span className="flex items-center gap-2"><input type="radio" name="variant" checked={variantId === v.id} onChange={() => { setVariantId(v.id); setError(''); }} className="accent-[hsl(var(--accent))]" /> {v.name}</span>
                <span className="text-sm text-muted">{Number(v.priceDelta) ? `+${money(v.priceDelta)}` : 'Included'}</span>
              </label>
            ))}
          </div>
        </fieldset>
      )}

      {p.addonGroups.map((g: any) => (
        <fieldset key={g.id}>
          <legend className="mb-2 text-sm font-medium">{g.name} <span className="text-xs font-normal text-muted">{g.minSelect > 0 ? `Choose ${g.minSelect}${g.maxSelect > g.minSelect ? `–${g.maxSelect}` : ''}` : `Optional, up to ${g.maxSelect}`}</span></legend>
          <div className="grid gap-2">
            {g.addons.map((a: any) => (
              <label key={a.id} className="flex cursor-pointer items-center justify-between rounded-xl border border-border p-3 has-[:checked]:border-accent has-[:checked]:bg-accent/10">
                <span className="flex items-center gap-2"><input type={g.maxSelect === 1 ? 'radio' : 'checkbox'} name={g.id} checked={!!chosen[g.id]?.includes(a.id)} onChange={() => toggle(g, a.id)} className="accent-[hsl(var(--accent))]" /> {a.name}</span>
                <span className="text-sm text-muted">{Number(a.price) ? `+${money(a.price)}` : 'Free'}</span>
              </label>
            ))}
          </div>
        </fieldset>
      ))}

      <div>
        <label htmlFor="notes" className="mb-1 block text-sm font-medium">Special instructions</label>
        <Textarea id="notes" value={notes} maxLength={300} onChange={(e) => setNotes(e.target.value)} placeholder="Allergies, how you like it cooked…" />
      </div>
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      <div className="flex items-center gap-3">
        <div className="flex items-center rounded-xl border border-border">
          <button className="p-3" aria-label="Decrease quantity" onClick={() => setQty((q) => Math.max(1, q - 1))}><Minus className="h-4 w-4" /></button>
          <span className="w-8 text-center font-medium" aria-live="polite">{qty}</span>
          <button className="p-3" aria-label="Increase quantity" onClick={() => setQty((q) => Math.min(50, q + 1))}><Plus className="h-4 w-4" /></button>
        </div>
        <Button size="lg" className="flex-1" onClick={submit}>Add to order · {money(unit * qty)}</Button>
      </div>
    </div>
  );
}

export function useAddToCart() {
  const { dispatch } = useCart();
  const toast = useToast();
  const [p, setP] = useState<any>(null);
  const add = (prod: any) => {
    if (!prod.variants?.length && !prod.addonGroups?.length) {
      dispatch({ t: 'add', line: { productId: prod.id, name: prod.name, slug: prod.slug, imageUrl: prod.images?.[0]?.url, addonIds: [], addonNames: [], unitPrice: Number(prod.discountPrice ?? prod.price), quantity: 1 } });
      toast('success', `${prod.name} added to your order`);
    } else setP(prod);
  };
  const modal = <Modal open={!!p} onClose={() => setP(null)} title={p?.name ?? ''}>{p && <ProductOptions p={p} onDone={() => setP(null)} />}</Modal>;
  return { add, modal };
}
