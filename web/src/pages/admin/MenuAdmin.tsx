import { PROTEINS } from '@/lib/proteins';
import { prepareImage } from '@/lib/image';
import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Download, GripVertical, ImagePlus, Languages, Pencil, Plus, Sparkles, Trash2, Upload } from 'lucide-react';
import { Badge, Button, Card, ConfirmButton, EmptyState, ErrorState, Field, Input, Modal, QueryBoundary, Select, Switch, Tabs, Textarea, useToast } from '@/components/ui';
import { ProductCard, FoodImage } from '@/components/Food';
import { api, download, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { money } from '@/lib/format';
import { useSeo } from '@/lib/hooks';

const ALLERGENS = ['gluten', 'dairy', 'nuts', 'peanuts', 'egg', 'soy', 'shellfish', 'fish', 'sesame'];
const blank = (categoryId: string) => ({ categoryId, name: '', description: '', price: 0, discountPrice: null as number | null, isVegetarian: false, isVegan: false, allergens: [] as string[], proteins: [] as string[], prepMinutes: 15, isAvailable: true, isFeatured: false, isChefPick: false, isPublished: true, availableFrom: '', availableTo: '', translations: {} as Record<string, { name?: string; description?: string }>, images: [] as { url: string; alt?: string }[], variants: [] as { name: string; priceDelta: number }[], addonGroups: [] as any[], recipe: [] as { ingredientId: string; quantity: number }[] });

export default function MenuAdmin() {
  useSeo('Menu management');
  const qc = useQueryClient(); const toast = useToast(); const { can } = useAuth();
  const menus = useQuery({ queryKey: ['menus'], queryFn: () => api('/api/menus') });
  const [catId, setCatId] = useState<string>('');
  const [edit, setEdit] = useState<any>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [catModal, setCatModal] = useState<any>(null);
  const [menuModal, setMenuModal] = useState<any>(null);
  const dragId = useRef<string | null>(null);

  const cats: any[] = (menus.data ?? []).flatMap((m: any) => m.categories.map((c: any) => ({ ...c, menuName: m.name })));
  const activeCat = catId || cats[0]?.id || '';
  const products = useQuery({ queryKey: ['products', activeCat], enabled: !!activeCat, queryFn: () => api('/api/products', { query: { categoryId: activeCat, pageSize: 200 } }) });
  const invalidate = () => { qc.invalidateQueries({ queryKey: ['menus'] }); qc.invalidateQueries({ queryKey: ['products'] }); qc.invalidateQueries({ queryKey: ['menu'] }); qc.invalidateQueries({ queryKey: ['home'] }); };
  const onError = (e: unknown) => toast('error', errorMessage(e));
  const reorder = useMutation({ mutationFn: (ids: string[]) => api('/api/categories/reorder', { method: 'PUT', body: { ids } }), onSuccess: invalidate, onError });
  const dup = useMutation({ mutationFn: (id: string) => api(`/api/products/${id}/duplicate`, { body: {} }), onSuccess: () => { toast('success', 'Duplicated as an unpublished draft'); invalidate(); }, onError });
  const del = useMutation({ mutationFn: (id: string) => api(`/api/products/${id}`, { method: 'DELETE' }), onSuccess: (r) => { toast('success', r.message ?? 'Deleted'); invalidate(); }, onError });
  const avail = useMutation({ mutationFn: ({ id, isAvailable }: any) => api(`/api/products/${id}/availability`, { method: 'PATCH', body: { isAvailable } }), onSuccess: invalidate, onError });
  const delCat = useMutation({ mutationFn: (id: string) => api(`/api/categories/${id}`, { method: 'DELETE' }), onSuccess: () => { setCatId(''); invalidate(); }, onError });

  const drop = (targetId: string) => {
    const from = dragId.current; dragId.current = null;
    if (!from || from === targetId) return;
    const ids = cats.map((c) => c.id); ids.splice(ids.indexOf(from), 1); ids.splice(ids.indexOf(targetId), 0, from);
    reorder.mutate(ids);
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[260px_1fr]">
      <aside className="space-y-3">
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => setMenuModal({ name: '' })}><Plus className="h-4 w-4" /> Menu</Button>
          <Button size="sm" variant="outline" onClick={() => setCatModal({ menuId: menus.data?.[0]?.id, name: '' })} disabled={!menus.data?.length}><Plus className="h-4 w-4" /> Category</Button>
        </div>
        <QueryBoundary q={menus}>
          {(ms) => ms.map((m: any) => (
            <div key={m.id}>
              <div className="mb-1 flex items-center justify-between px-1 text-xs font-semibold uppercase tracking-wide text-muted"><span>{m.name}{!m.isActive && ' (hidden)'}</span><button className="underline" onClick={() => setMenuModal(m)}>edit</button></div>
              <ul className="space-y-1">
                {m.categories.length === 0 && <li className="px-2 text-sm text-muted">No categories</li>}
                {m.categories.map((c: any) => (
                  <li key={c.id} draggable onDragStart={() => (dragId.current = c.id)} onDragOver={(e) => e.preventDefault()} onDrop={() => drop(c.id)}>
                    <button onClick={() => setCatId(c.id)} className={`flex w-full items-center gap-2 rounded-xl px-2 py-2 text-left text-sm ${activeCat === c.id ? 'bg-brand text-brand-fg' : 'hover:bg-surface-2'}`}>
                      <GripVertical className="h-4 w-4 shrink-0 cursor-grab opacity-60" aria-hidden /><span className="flex-1 truncate">{c.name}{!c.isActive && ' (hidden)'}</span><span className="text-xs opacity-70">{c._count.products}</span>
                    </button>
                  </li>))}
              </ul>
            </div>))}
        </QueryBoundary>
        <p className="text-xs text-muted">Drag categories to reorder them on the website.</p>
        <div className="flex flex-col gap-2 border-t border-border pt-3">
          <Button size="sm" variant="outline" onClick={() => setImportOpen(true)}><Upload className="h-4 w-4" /> Import CSV</Button>
          <Button size="sm" variant="outline" onClick={() => download('/api/products/export.csv', 'menu.csv').catch((e) => toast('error', errorMessage(e)))}><Download className="h-4 w-4" /> Export CSV</Button>
        </div>
      </aside>

      <section className="min-w-0">
        {!activeCat ? <EmptyState title="Create your first category" action={<Button onClick={() => setCatModal({ menuId: menus.data?.[0]?.id, name: '' })} disabled={!menus.data?.length}>Add category</Button>}>Categories group dishes on the menu (Starters, Mains…).</EmptyState> : (
          <>
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2"><h2 className="text-2xl">{cats.find((c) => c.id === activeCat)?.name}</h2>
              <div className="flex gap-2"><Button size="sm" variant="outline" onClick={() => setCatModal(cats.find((c) => c.id === activeCat))}><Pencil className="h-4 w-4" /> Category</Button>
                <ConfirmButton size="sm" variant="ghost" className="text-danger" message="Delete this category? It must be empty." onConfirm={() => delCat.mutate(activeCat)}><Trash2 className="h-4 w-4" /></ConfirmButton>
                <Button size="sm" onClick={() => setEdit(blank(activeCat))}><Plus className="h-4 w-4" /> Add dish</Button></div></div>
            <QueryBoundary q={products} empty={(d) => d.items.length === 0}>
              {(d) => (
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  {d.items.map((p: any) => (
                    <Card key={p.id} className="flex flex-col gap-3 p-3">
                      <div className="flex gap-3"><FoodImage src={p.images[0]?.url} name={p.name} className="h-20 w-20 shrink-0 rounded-xl" />
                        <div className="min-w-0"><p className="truncate font-medium">{p.name}</p><p className="text-sm">{money(p.discountPrice ?? p.price)} {p.discountPrice && <span className="text-muted line-through">{money(p.price)}</span>}</p>
                          <div className="mt-1 flex flex-wrap gap-1">{!p.isPublished && <Badge tone="warn">Draft</Badge>}{p.isFeatured && <Badge tone="brand">Featured</Badge>}{p.isChefPick && <Badge tone="brand">Chef</Badge>}{p.variants.length > 0 && <Badge>{p.variants.length} sizes</Badge>}</div></div></div>
                      <div className="flex items-center justify-between border-t border-border pt-2">
                        <label className="flex items-center gap-2 text-sm"><Switch label={`${p.name} available`} checked={p.isAvailable} onChange={(v) => avail.mutate({ id: p.id, isAvailable: v })} />{p.isAvailable ? 'Available' : 'Sold out'}</label>
                        <div className="flex"><button className="rounded-lg p-2 hover:bg-surface-2" aria-label={`Edit ${p.name}`} onClick={() => setEdit({ ...blank(p.categoryId), ...p, price: Number(p.price), discountPrice: p.discountPrice == null ? null : Number(p.discountPrice), availableFrom: p.availableFrom ?? '', availableTo: p.availableTo ?? '', variants: p.variants.map((v: any) => ({ name: v.name, priceDelta: Number(v.priceDelta) })), addonGroups: p.addonGroups.map((g: any) => ({ name: g.name, minSelect: g.minSelect, maxSelect: g.maxSelect, addons: g.addons.map((a: any) => ({ name: a.name, price: Number(a.price) })) })), recipe: p.recipe.map((r: any) => ({ ingredientId: r.ingredientId, quantity: Number(r.quantity) })), images: p.images.map((i: any) => ({ url: i.url, alt: i.alt ?? '' })), id: p.id })}><Pencil className="h-4 w-4" /></button>
                          <button className="rounded-lg p-2 hover:bg-surface-2" aria-label={`Duplicate ${p.name}`} onClick={() => dup.mutate(p.id)}><Copy className="h-4 w-4" /></button>
                          <ConfirmButton size="icon" variant="ghost" className="h-9 w-9 text-danger" message={`Delete “${p.name}”? Dishes that appear in past orders are hidden instead.`} onConfirm={() => del.mutate(p.id)} aria-label={`Delete ${p.name}`}><Trash2 className="h-4 w-4" /></ConfirmButton></div></div>
                    </Card>))}
                </div>)}
            </QueryBoundary>
          </>)}
      </section>

      {edit && <ProductEditor key={edit.id ?? 'new'} initial={edit} cats={cats} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); invalidate(); }} canAI={can('ai.use')} />}
      <CategoryModal value={catModal} menus={menus.data ?? []} onClose={() => setCatModal(null)} onSaved={invalidate} />
      <MenuModal value={menuModal} onClose={() => setMenuModal(null)} onSaved={invalidate} />
      <ImportModal open={importOpen} onClose={() => setImportOpen(false)} onDone={invalidate} />
    </div>
  );
}

function ProductEditor({ initial, cats, onClose, onSaved, canAI }: { initial: any; cats: any[]; onClose: () => void; onSaved: () => void; canAI: boolean }) {
  const toast = useToast();
  const [p, setP] = useState<any>(initial);
  const [tab, setTab] = useState<'details' | 'options' | 'images' | 'recipe' | 'schedule'>('details');
  const [error, setError] = useState<Record<string, string> | string | null>(null);
  const ing = useQuery({ queryKey: ['ingredients-all'], queryFn: () => api('/api/inventory', { query: { pageSize: 200 } }), retry: false });
  const set = (k: string, v: any) => setP((x: any) => ({ ...x, [k]: v }));
  const save = useMutation({
    mutationFn: () => {
      const body = { ...p, description: p.description || null, price: Number(p.price), discountPrice: p.discountPrice === null || p.discountPrice === '' ? null : Number(p.discountPrice), prepMinutes: Number(p.prepMinutes), id: undefined, category: undefined, slug: undefined, createdAt: undefined, updatedAt: undefined, sortOrder: undefined, images: p.images.map((i: any) => ({ url: i.url, alt: i.alt || null })) };
      return p.id ? api(`/api/products/${p.id}`, { method: 'PUT', body }) : api('/api/products', { body });
    },
    onSuccess: () => { toast('success', 'Saved — live on the website'); onSaved(); }, onError: (e: any) => setError(e.message),
  });
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const upload = async (f0: File) => {
    setUploading(true); setUploadError(null);
    try {
      const f = await prepareImage(f0);
      if (f.size > 5 * 1024 * 1024) throw new Error('This photo is larger than 5 MB — please choose a smaller one.');
      const fd = new FormData(); fd.append('file', f);
      const r = await api('/api/uploads', { body: fd });
      setP((x: any) => ({ ...x, images: [...x.images, { url: r.url, alt: x.name }] }));
    } catch (e) { setUploadError(errorMessage(e)); toast('error', errorMessage(e)); }
    finally { setUploading(false); }
  };
  const ai = useMutation({ mutationFn: () => api('/api/ai/describe-product', { body: { productId: p.id } }), onSuccess: (r) => set('description', r.text), onError: (e) => toast('error', errorMessage(e)) });
  const tr = useMutation({ mutationFn: (language: string) => api('/api/ai/translate', { body: { language, name: p.name, description: p.description ?? undefined } }).then((r) => ({ language, r })), onSuccess: ({ language, r }) => set('translations', { ...p.translations, [language]: r }), onError: (e) => toast('error', errorMessage(e)) });
  const [lang, setLang] = useState('zh');
  const preview = { ...p, id: 'preview', slug: 'x', images: p.images, discountPrice: p.discountPrice === '' ? null : p.discountPrice, variants: p.variants };

  return (
    <Modal open onClose={onClose} title={p.id ? `Edit ${initial.name}` : 'New dish'} wide>
      <form onSubmit={(e) => { e.preventDefault(); setError(null); save.mutate(); }} className="grid gap-6 md:grid-cols-[1fr_240px]">
        <div className="space-y-4">
          <Tabs value={tab} onChange={setTab} tabs={[{ id: 'details', label: 'Details' }, { id: 'options', label: 'Sizes & add-ons' }, { id: 'images', label: 'Photos' }, { id: 'recipe', label: 'Recipe' }, { id: 'schedule', label: 'Availability' }]} />
          {tab === 'details' && (<div className="space-y-4">
            <div className="flex items-center gap-3">
              {p.images[0] ? <img src={p.images[0].url} alt="" className="h-16 w-16 rounded-xl object-cover" /> : <div className="grid h-16 w-16 place-items-center rounded-xl border-2 border-dashed border-border text-muted"><ImagePlus className="h-6 w-6" /></div>}
              <div className="space-y-1">
                <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl border border-border px-3 py-1.5 text-sm font-medium hover:bg-surface-2 has-[:focus-visible]:ring-2"><ImagePlus className="h-4 w-4" />{uploading ? 'Uploading…' : p.images.length ? 'Add another photo' : 'Add a photo'}<input type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" disabled={uploading} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) upload(f); }} /></label>
                {uploadError ? <p role="alert" className="text-xs text-danger">{uploadError}</p> : <p className="text-xs text-muted">JPEG, PNG or WebP — large photos are resized automatically.</p>}
              </div>
            </div>
            <Field label="Name">{(id) => <Input id={id} required maxLength={120} value={p.name} onChange={(e) => set('name', e.target.value)} />}</Field>
            <Field label="Category">{(id) => <Select id={id} value={p.categoryId} onChange={(e) => set('categoryId', e.target.value)}>{cats.map((c) => <option key={c.id} value={c.id}>{c.menuName} › {c.name}</option>)}</Select>}</Field>
            <Field label="Description" hint={canAI && p.id ? undefined : 'Save the dish first to use AI descriptions'}>{(id) => (<div className="space-y-2"><Textarea id={id} maxLength={2000} value={p.description ?? ''} onChange={(e) => set('description', e.target.value)} />
              {canAI && p.id && <Button type="button" size="sm" variant="outline" loading={ai.isPending} onClick={() => ai.mutate()}><Sparkles className="h-4 w-4" /> Suggest with AI</Button>}</div>)}</Field>
            <div className="grid grid-cols-2 gap-4"><Field label="Price">{(id) => <Input id={id} type="number" step="0.01" min="0" required value={p.price} onChange={(e) => set('price', e.target.value)} />}</Field>
              <Field label="Discounted price" hint="Optional">{(id) => <Input id={id} type="number" step="0.01" min="0" value={p.discountPrice ?? ''} onChange={(e) => set('discountPrice', e.target.value === '' ? null : e.target.value)} />}</Field></div>
            <div className="flex flex-wrap gap-5 text-sm">{[['isVegetarian', '🥬 Vegetarian'], ['isVegan', '🌱 Vegan'], ['isFeatured', 'Featured on homepage'], ['isChefPick', 'Chef’s pick'], ['isPublished', 'Published']].map(([k, l]) => <label key={k} className="flex items-center gap-2"><input type="checkbox" checked={p[k]} onChange={(e) => set(k, e.target.checked)} /> {l}</label>)}</div>
            <fieldset><legend className="mb-1 text-sm font-medium">Contains meat / seafood <span className="font-normal text-muted">(shown as icons on the menu)</span></legend><div className="flex flex-wrap gap-2">{PROTEINS.map((x) => <label key={x.key} className="flex cursor-pointer items-center gap-1 rounded-full border border-border px-2.5 py-1 text-xs has-[:checked]:border-brand has-[:checked]:bg-brand/10 has-[:focus-visible]:ring-2"><input type="checkbox" className="sr-only" checked={(p.proteins ?? []).includes(x.key)} onChange={(e) => set('proteins', e.target.checked ? [...(p.proteins ?? []), x.key] : (p.proteins ?? []).filter((y: string) => y !== x.key))} /><span aria-hidden>{x.icon}</span>{x.label}</label>)}</div></fieldset>
            <fieldset><legend className="mb-1 text-sm font-medium">Allergens</legend><div className="flex flex-wrap gap-2">{ALLERGENS.map((a) => <label key={a} className="flex items-center gap-1 rounded-full border border-border px-2.5 py-1 text-xs capitalize has-[:checked]:border-danger has-[:checked]:bg-danger/10"><input type="checkbox" className="sr-only" checked={p.allergens.includes(a)} onChange={(e) => set('allergens', e.target.checked ? [...p.allergens, a] : p.allergens.filter((x: string) => x !== a))} />{a}</label>)}</div></fieldset>
            {canAI && p.id && <div className="rounded-xl border border-border p-3"><p className="mb-2 flex items-center gap-2 text-sm font-medium"><Languages className="h-4 w-4" /> Translations</p><div className="flex gap-2"><Select aria-label="Language" className="w-32" value={lang} onChange={(e) => setLang(e.target.value)}>{['zh', 'ms', 'ta', 'hi', 'ja', 'ko', 'fr', 'es', 'ar'].map((l) => <option key={l} value={l}>{l}</option>)}</Select><Button type="button" size="sm" variant="outline" loading={tr.isPending} onClick={() => tr.mutate(lang)}>Translate with AI</Button></div>
              {Object.entries(p.translations).map(([l, v]: any) => <p key={l} className="mt-2 text-xs"><strong>{l}</strong>: {v.name} — {v.description}</p>)}<p className="mt-1 text-xs text-muted">Enable languages under Settings → Site to show the language switcher.</p></div>}
          </div>)}

          {tab === 'options' && (<div className="space-y-5">
            <div><div className="mb-2 flex items-center justify-between"><h4 className="font-medium">Sizes / variants</h4><Button type="button" size="sm" variant="outline" onClick={() => set('variants', [...p.variants, { name: '', priceDelta: 0 }])}>Add size</Button></div>
              {p.variants.map((v: any, i: number) => <div key={i} className="mb-2 flex gap-2"><Input aria-label="Size name" required placeholder="e.g. Large" value={v.name} onChange={(e) => set('variants', p.variants.map((x: any, j: number) => (j === i ? { ...x, name: e.target.value } : x)))} /><Input aria-label="Price difference" type="number" step="0.01" className="w-28" value={v.priceDelta} onChange={(e) => set('variants', p.variants.map((x: any, j: number) => (j === i ? { ...x, priceDelta: Number(e.target.value) } : x)))} /><Button type="button" variant="ghost" size="icon" aria-label="Remove size" onClick={() => set('variants', p.variants.filter((_: any, j: number) => j !== i))}><Trash2 className="h-4 w-4" /></Button></div>)}
              <p className="text-xs text-muted">Price difference is added to the base price. If sizes exist, customers must choose one.</p></div>
            <div><div className="mb-2 flex items-center justify-between"><h4 className="font-medium">Add-on groups (toppings, extras)</h4><Button type="button" size="sm" variant="outline" onClick={() => set('addonGroups', [...p.addonGroups, { name: '', minSelect: 0, maxSelect: 1, addons: [{ name: '', price: 0 }] }])}>Add group</Button></div>
              {p.addonGroups.map((g: any, gi: number) => { const upd = (patch: any) => set('addonGroups', p.addonGroups.map((x: any, j: number) => (j === gi ? { ...x, ...patch } : x))); return (
                <Card key={gi} className="mb-3 space-y-2 p-3"><div className="flex gap-2"><Input aria-label="Group name" required placeholder="Group name, e.g. Toppings" value={g.name} onChange={(e) => upd({ name: e.target.value })} /><Input aria-label="Minimum" type="number" min={0} className="w-20" title="Minimum" value={g.minSelect} onChange={(e) => upd({ minSelect: Number(e.target.value) })} /><Input aria-label="Maximum" type="number" min={1} className="w-20" title="Maximum" value={g.maxSelect} onChange={(e) => upd({ maxSelect: Number(e.target.value) })} /><Button type="button" variant="ghost" size="icon" aria-label="Remove group" onClick={() => set('addonGroups', p.addonGroups.filter((_: any, j: number) => j !== gi))}><Trash2 className="h-4 w-4" /></Button></div>
                  {g.addons.map((a: any, ai2: number) => <div key={ai2} className="flex gap-2 pl-4"><Input aria-label="Add-on name" required placeholder="Option" value={a.name} onChange={(e) => upd({ addons: g.addons.map((x: any, j: number) => (j === ai2 ? { ...x, name: e.target.value } : x)) })} /><Input aria-label="Add-on price" type="number" step="0.01" min="0" className="w-28" value={a.price} onChange={(e) => upd({ addons: g.addons.map((x: any, j: number) => (j === ai2 ? { ...x, price: Number(e.target.value) } : x)) })} /><Button type="button" variant="ghost" size="icon" aria-label="Remove option" onClick={() => upd({ addons: g.addons.filter((_: any, j: number) => j !== ai2) })}><Trash2 className="h-4 w-4" /></Button></div>)}
                  <Button type="button" size="sm" variant="ghost" onClick={() => upd({ addons: [...g.addons, { name: '', price: 0 }] })}>+ option</Button></Card>); })}</div>
          </div>)}

          {tab === 'images' && (<div className="space-y-3"><div className="grid grid-cols-3 gap-3">{p.images.map((im: any, i: number) => (<div key={i} className="space-y-1"><img src={im.url} alt={im.alt ?? ''} className="aspect-square w-full rounded-xl object-cover" /><Input aria-label="Alt text" placeholder="Alt text" value={im.alt ?? ''} onChange={(e) => set('images', p.images.map((x: any, j: number) => (j === i ? { ...x, alt: e.target.value } : x)))} /><button type="button" className="text-xs text-danger underline" onClick={() => set('images', p.images.filter((_: any, j: number) => j !== i))}>Remove</button></div>))}
            <label className="grid aspect-square cursor-pointer place-items-center rounded-xl border-2 border-dashed border-border text-sm text-muted hover:bg-surface-2"><span className="flex flex-col items-center gap-1"><ImagePlus className="h-6 w-6" />{uploading ? 'Uploading…' : 'Upload'}</span><input type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" disabled={uploading} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) upload(f); }} /></label></div>
            {uploading && <p className="text-sm text-muted">Uploading…</p>}{uploadError && <p role="alert" className="text-sm text-danger">{uploadError}</p>}
            <p className="text-xs text-muted">JPEG, PNG or WebP up to 5 MB. Add descriptive alt text for accessibility and SEO. Use real photographs of your own dishes.</p></div>)}

          {tab === 'recipe' && (<div className="space-y-3"><p className="text-sm text-muted">Ingredients consumed each time this dish is sold (deducted when an order completes).</p>
            {ing.error ? <ErrorState error={ing.error} /> : p.recipe.map((r: any, i: number) => <div key={i} className="flex gap-2"><Select aria-label="Ingredient" value={r.ingredientId} onChange={(e) => set('recipe', p.recipe.map((x: any, j: number) => (j === i ? { ...x, ingredientId: e.target.value } : x)))}><option value="">Choose…</option>{(ing.data?.items ?? []).map((g: any) => <option key={g.id} value={g.id}>{g.name} ({g.unit})</option>)}</Select><Input aria-label="Quantity" type="number" step="0.001" min="0.001" className="w-28" value={r.quantity} onChange={(e) => set('recipe', p.recipe.map((x: any, j: number) => (j === i ? { ...x, quantity: Number(e.target.value) } : x)))} /><Button type="button" variant="ghost" size="icon" aria-label="Remove ingredient" onClick={() => set('recipe', p.recipe.filter((_: any, j: number) => j !== i))}><Trash2 className="h-4 w-4" /></Button></div>)}
            <Button type="button" size="sm" variant="outline" onClick={() => set('recipe', [...p.recipe, { ingredientId: '', quantity: 1 }])}>Add ingredient</Button></div>)}

          {tab === 'schedule' && (<div className="space-y-4"><label className="flex items-center gap-3"><Switch label="Available" checked={p.isAvailable} onChange={(v) => set('isAvailable', v)} /> Available to order now</label>
            <div className="grid grid-cols-2 gap-4"><Field label="Only from (HH:MM)">{(id) => <Input id={id} type="time" value={p.availableFrom} onChange={(e) => set('availableFrom', e.target.value)} />}</Field><Field label="Until">{(id) => <Input id={id} type="time" value={p.availableTo} onChange={(e) => set('availableTo', e.target.value)} />}</Field></div>
            <Field label="Preparation time (minutes)">{(id) => <Input id={id} type="number" min={1} max={240} value={p.prepMinutes} onChange={(e) => set('prepMinutes', e.target.value)} />}</Field></div>)}

          {error && <ErrorState error={new Error(typeof error === 'string' ? error : 'Please fix the highlighted fields')} />}
          <div className="flex justify-end gap-2 border-t border-border pt-4"><Button type="button" variant="outline" onClick={onClose}>Cancel</Button><Button loading={save.isPending}>{p.id ? 'Save changes' : 'Create dish'}</Button></div>
        </div>
        <aside className="hidden md:block"><p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Live preview</p><ProductCard p={{ ...preview, name: p.name || 'Dish name', price: p.price || 0 }} /></aside>
      </form>
    </Modal>
  );
}

function CategoryModal({ value, menus, onClose, onSaved }: { value: any; menus: any[]; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [c, setC] = useState<any>(null);
  const v = c ?? value;
  const save = useMutation({ mutationFn: () => (v.id ? api(`/api/categories/${v.id}`, { method: 'PUT', body: { name: v.name, description: v.description || null, isActive: v.isActive ?? true, menuId: v.menuId } }) : api('/api/categories', { body: { menuId: v.menuId, name: v.name, description: v.description || null } })), onSuccess: () => { setC(null); onClose(); onSaved(); toast('success', 'Category saved'); }, onError: (e) => toast('error', errorMessage(e)) });
  return (
    <Modal open={!!value} onClose={() => { setC(null); onClose(); }} title={value?.id ? 'Edit category' : 'New category'}>
      {v && <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <Field label="Name">{(id) => <Input id={id} required value={v.name} onChange={(e) => setC({ ...v, name: e.target.value })} />}</Field>
        <Field label="Menu">{(id) => <Select id={id} value={v.menuId} onChange={(e) => setC({ ...v, menuId: e.target.value })}>{menus.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</Select>}</Field>
        <Field label="Description">{(id) => <Textarea id={id} value={v.description ?? ''} onChange={(e) => setC({ ...v, description: e.target.value })} />}</Field>
        {v.id && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={v.isActive ?? true} onChange={(e) => setC({ ...v, isActive: e.target.checked })} /> Visible on website</label>}
        <div className="flex justify-end"><Button loading={save.isPending}>Save</Button></div></form>}
    </Modal>
  );
}

function MenuModal({ value, onClose, onSaved }: { value: any; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [m, setM] = useState<any>(null);
  const v = m ?? value;
  const save = useMutation({ mutationFn: () => { const body = { name: v.name, description: v.description || null, isActive: v.isActive ?? true, availableFrom: v.availableFrom || '', availableTo: v.availableTo || '' }; return v.id ? api(`/api/menus/${v.id}`, { method: 'PUT', body }) : api('/api/menus', { body }); }, onSuccess: () => { setM(null); onClose(); onSaved(); toast('success', 'Menu saved'); }, onError: (e) => toast('error', errorMessage(e)) });
  const del = useMutation({ mutationFn: () => api(`/api/menus/${v.id}`, { method: 'DELETE' }), onSuccess: () => { setM(null); onClose(); onSaved(); }, onError: (e) => toast('error', errorMessage(e)) });
  return (
    <Modal open={!!value} onClose={() => { setM(null); onClose(); }} title={value?.id ? 'Edit menu' : 'New menu'}>
      {v && <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <Field label="Menu name" hint="e.g. Lunch, Dinner, Drinks">{(id) => <Input id={id} required value={v.name} onChange={(e) => setM({ ...v, name: e.target.value })} />}</Field>
        <div className="grid grid-cols-2 gap-4"><Field label="Served from">{(id) => <Input id={id} type="time" value={v.availableFrom ?? ''} onChange={(e) => setM({ ...v, availableFrom: e.target.value })} />}</Field><Field label="Until">{(id) => <Input id={id} type="time" value={v.availableTo ?? ''} onChange={(e) => setM({ ...v, availableTo: e.target.value })} />}</Field></div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={v.isActive ?? true} onChange={(e) => setM({ ...v, isActive: e.target.checked })} /> Visible on website</label>
        <div className="flex justify-between">{v.id ? <ConfirmButton variant="ghost" className="text-danger" message="Delete this menu and its empty categories?" onConfirm={() => del.mutate()}>Delete</ConfirmButton> : <span />}<Button loading={save.isPending}>Save</Button></div></form>}
    </Modal>
  );
}

function ImportModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const [csv, setCsv] = useState('');
  const [res, setRes] = useState<any>(null);
  const m = useMutation({ mutationFn: () => api('/api/products/import', { body: { csv } }), onSuccess: (r) => { setRes(r); onDone(); } });
  return (
    <Modal open={open} onClose={onClose} title="Import menu from CSV" wide>
      <p className="mb-2 text-sm text-muted">Required columns: <code>category, name, price</code>. Optional: description, discountPrice, vegetarian, vegan, allergens (separate with |), proteins (chicken|pork|beef|lamb|goat|duck|turkey|fish|prawn|crab|squid|egg|other), prepMinutes, available. Existing dishes with the same name are updated. Excel files: save as CSV first.</p>
      <input type="file" accept=".csv,text/csv" aria-label="CSV file" className="mb-2 text-sm" onChange={async (e) => { const f = e.target.files?.[0]; if (f) setCsv(await f.text()); }} />
      <Textarea aria-label="CSV contents" className="min-h-40 font-mono text-xs" value={csv} onChange={(e) => setCsv(e.target.value)} placeholder="category,name,price&#10;Starters,Soup,8" />
      {m.error && <div className="mt-2"><ErrorState error={m.error} /></div>}
      {res && <div className="mt-3 rounded-xl bg-surface-2 p-3 text-sm"><p>Created {res.created}, updated {res.updated}.</p>{res.errors.map((e: string) => <p key={e} className="text-danger">{e}</p>)}</div>}
      <div className="mt-4 flex justify-end"><Button loading={m.isPending} disabled={!csv.trim()} onClick={() => m.mutate()}>Import</Button></div>
    </Modal>
  );
}
