import { PROTEINS } from '@/lib/proteins';
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Search, X } from 'lucide-react';
import { Button, EmptyState, Input, QueryBoundary, Skeleton } from '@/components/ui';
import { ProductCard, VegMark } from '@/components/Food';
import { useAddToCart } from '@/components/ProductModal';
import { useCart } from '@/lib/cart';
import { useHome, useMenu, useSeo } from '@/lib/hooks';
import { usePublicOutlets } from '@/lib/outlet';
import { BranchPicker } from '@/components/BranchPicker';
import { cn } from '@/lib/format';

const ALLERGENS = ['gluten', 'dairy', 'nuts', 'peanuts', 'egg', 'soy', 'shellfish', 'fish', 'sesame'];

export default function Menu({ forcedMode }: { forcedMode?: 'DINE_IN' }) {
  const { state: cartState } = useCart();
  const outlets = usePublicOutlets();
  const q = useMenu(cartState.outletId);
  const { data: home } = useHome();
  const [sp, setSp] = useSearchParams();
  const { state, dispatch } = useCart();
  const { add, modal } = useAddToCart();
  const [search, setSearch] = useState('');
  const [diet, setDiet] = useState<'all' | 'veg' | 'vegan'>('all');
  const [avoid, setAvoid] = useState<string[]>([]);
  const [meat, setMeat] = useState<string[]>([]);
  const [menuIdx, setMenuIdx] = useState(0);
  useSeo('Menu', 'Browse The Minerva menu and order online for dine-in, takeaway or delivery.');
  const catSlug = sp.get('category');
  const mode = sp.get('type');

  const menus: any[] = q.data ?? [];
  const menu = menus[Math.min(menuIdx, Math.max(0, menus.length - 1))];
  const categories: any[] = menu?.categories ?? [];

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return categories
      .filter((c) => !catSlug || c.slug === catSlug)
      .map((c) => ({
        ...c,
        products: c.products.filter((p: any) =>
          (!term || p.name.toLowerCase().includes(term) || p.description?.toLowerCase().includes(term)) &&
          (diet === 'all' || (diet === 'veg' ? p.isVegetarian || p.isVegan : p.isVegan)) &&
          (!meat.length || meat.some((m) => p.proteins?.includes(m))) &&
          !avoid.some((a) => p.allergens?.map((x: string) => x.toLowerCase()).includes(a))),
      }))
      .filter((c) => c.products.length);
  }, [categories, search, diet, avoid, meat, catSlug]);

  if (mode === 'takeaway' && state.mode !== 'TAKEAWAY' && !state.tableToken) dispatch({ t: 'mode', mode: 'TAKEAWAY' });

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <BranchPicker />
      <header className="mb-6">
        <h1 className="text-4xl">Our menu</h1>
        {forcedMode === 'DINE_IN' && state.tableLabel && <p className="mt-1 text-sm text-muted">Add dishes and send your order straight to the kitchen from table {state.tableLabel}.</p>}
      </header>

      <div className="sticky top-16 z-30 -mx-4 mb-6 space-y-3 border-b border-border bg-bg/90 px-4 py-3 backdrop-blur">
        {menus.length > 1 && (
          <div className="flex gap-2 overflow-x-auto">{menus.map((m, i) => <button key={m.id} onClick={() => { setMenuIdx(i); setSp({}); }} className={cn('whitespace-nowrap rounded-full border px-4 py-1.5 text-sm', i === menuIdx ? 'border-brand bg-brand text-brand-fg' : 'border-border')}>{m.name}{!m.availableNow && ' (closed now)'}</button>)}</div>
        )}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden />
            <Input type="search" aria-label="Search the menu" placeholder="Search dishes…" className="pl-9" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
        </div>
        <div className="flex gap-2 overflow-x-auto pb-1" aria-label="Categories">
          <button onClick={() => setSp({})} className={cn('whitespace-nowrap rounded-full px-3 py-1 text-sm', !catSlug ? 'bg-accent text-accent-fg' : 'bg-surface-2')}>All</button>
          {categories.map((c) => <button key={c.id} onClick={() => setSp({ category: c.slug })} className={cn('whitespace-nowrap rounded-full px-3 py-1 text-sm', catSlug === c.slug ? 'bg-accent text-accent-fg' : 'bg-surface-2')}>{c.name}</button>)}
        </div>
        <div className="flex gap-1.5 overflow-x-auto pb-1" role="group" aria-label="Filter by diet, meat or seafood">
          {([['veg', 'Veg', <VegMark key="v" />], ['vegan', 'Vegan', <span key="g" aria-hidden>🌱</span>]] as const).map(([v, l, icon]) => (
            <button key={v} aria-pressed={diet === v} onClick={() => setDiet((d) => (d === v ? 'all' : v))} className={cn('inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2.5 py-1 text-xs', diet === v ? 'border-brand bg-brand text-brand-fg' : 'border-border')}>{icon}{l}</button>
          ))}
          {PROTEINS.filter((x) => x.key !== 'other' || categories.some((c) => c.products.some((p: any) => p.proteins?.includes('other')))).filter((x) => categories.some((c) => c.products.some((p: any) => p.proteins?.includes(x.key)))).map((x) => (
            <button key={x.key} aria-pressed={meat.includes(x.key)} onClick={() => setMeat((m) => (m.includes(x.key) ? m.filter((y) => y !== x.key) : [...m, x.key]))} className={cn('inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2.5 py-1 text-xs', meat.includes(x.key) ? 'border-brand bg-brand text-brand-fg' : 'border-border')}><span aria-hidden>{x.icon}</span>{x.label}</button>
          ))}
          {(meat.length > 0 || diet !== 'all') && <button className="inline-flex items-center gap-1 whitespace-nowrap text-xs underline" onClick={() => { setMeat([]); setDiet('all'); }}><X className="h-3 w-3" /> clear</button>}
        </div>
        <details className="text-sm">
          <summary className="cursor-pointer text-muted">Hide dishes containing…{avoid.length > 0 && ` (${avoid.length})`}</summary>
          <div className="mt-2 flex flex-wrap gap-1.5">{ALLERGENS.map((a) => <button key={a} aria-pressed={avoid.includes(a)} onClick={() => setAvoid((x) => (x.includes(a) ? x.filter((y) => y !== a) : [...x, a]))} className={cn('rounded-full border px-2.5 py-1 text-xs capitalize', avoid.includes(a) ? 'border-danger bg-danger/10 text-danger' : 'border-border')}>{a}</button>)}
            {avoid.length > 0 && <button className="inline-flex items-center gap-1 text-xs underline" onClick={() => setAvoid([])}><X className="h-3 w-3" /> clear</button>}</div>
          <p className="mt-2 text-xs text-muted">Allergen labels are provided in good faith. Please tell us about any allergy when you order.</p>
        </details>
      </div>

      <QueryBoundary q={q} skeleton={<div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-72" />)}</div>}>
        {() => filtered.length === 0 ? (
          <EmptyState title={menus.length ? 'No dishes match' : 'The menu is being prepared'} action={search || diet !== 'all' || avoid.length || meat.length ? <Button variant="outline" onClick={() => { setSearch(''); setDiet('all'); setAvoid([]); setMeat([]); setSp({}); }}>Clear filters</Button> : undefined}>
            {menus.length ? 'Try changing your search or filters.' : 'Please check back soon.'}
          </EmptyState>
        ) : (
          <div className="space-y-12">
            {filtered.map((c) => (
              <section key={c.id} aria-labelledby={`cat-${c.id}`}>
                <h2 id={`cat-${c.id}`} className="mb-1 text-2xl">{c.name}</h2>
                {c.description && <p className="mb-4 text-sm text-muted">{c.description}</p>}
                <div className="mt-4 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">{c.products.map((p: any, i: number) => <ProductCard key={p.id} p={p} onAdd={add} index={i} />)}</div>
              </section>
            ))}
          </div>
        )}
      </QueryBoundary>
      {home?.config.loyaltyEnabled && <p className="mt-10 text-center text-sm text-muted">Sign in to earn rewards points on every order.</p>}
      {modal}
    </div>
  );
}
