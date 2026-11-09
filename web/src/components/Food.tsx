import { motion } from 'motion/react';
import { Plus } from 'lucide-react';
import { Link } from 'react-router-dom';
import { cn, money } from '@/lib/format';
import { proteinInfo } from '@/lib/proteins';

/** Standard food-labelling mark: green square-dot = vegetarian, red = contains meat / egg / seafood. */
export function VegMark({ nonVeg, className }: { nonVeg?: boolean; className?: string }) {
  const c = nonVeg ? '#c0392b' : '#1e8e3e';
  return (
    <span role="img" aria-label={nonVeg ? 'Non-vegetarian' : 'Vegetarian'} title={nonVeg ? 'Non-vegetarian' : 'Vegetarian'} className={cn('inline-grid h-4 w-4 shrink-0 place-items-center rounded-[3px] border-2 bg-white', className)} style={{ borderColor: c }}>
      <span className="h-2 w-2 rounded-full" style={{ background: c }} />
    </span>
  );
}

/** Small icons for the meat / seafood a dish contains (accessible: each has a text label). */
export function ProteinIcons({ proteins, className }: { proteins?: string[]; className?: string }) {
  const list = (proteins ?? []).map(proteinInfo).filter(Boolean) as NonNullable<ReturnType<typeof proteinInfo>>[];
  if (!list.length) return null;
  return (
    <span className={cn('inline-flex flex-wrap items-center gap-1', className)} aria-label={`Contains ${list.map((x) => x.label).join(', ')}`}>
      {list.map((x) => <span key={x.key} title={x.label} className="inline-flex h-6 items-center gap-1 rounded-full bg-surface-2 px-1.5 text-xs"><span aria-hidden>{x.icon}</span><span className="hidden sm:inline">{x.label.split(' ')[0]}</span></span>)}
    </span>
  );
}

/** Real photo when the owner uploaded one; otherwise a tasteful typographic tile (no stock photos are invented). */
export function FoodImage({ src, name, className, alt, priority }: { src?: string | null; name: string; className?: string; alt?: string; priority?: boolean }) {
  if (src) return <img src={src} alt={alt ?? name} loading={priority ? 'eager' : 'lazy'} decoding="async" className={cn('object-cover', className)} />;
  const hue = [...name].reduce((a, c) => a + c.charCodeAt(0), 0) % 360;
  return (
    <div role="img" aria-label={alt ?? name} className={cn('grid place-items-center overflow-hidden font-display text-3xl text-white/90', className)}
      style={{ background: `linear-gradient(135deg, hsl(${(hue % 60) + 130} 28% 26%), hsl(${(hue % 40) + 35} 40% 36%))` }}>
      {name.trim().charAt(0).toUpperCase()}
    </div>
  );
}

export function DietBadges({ p }: { p: { isVegan?: boolean; isVegetarian?: boolean; allergens?: string[]; proteins?: string[] } }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5 text-xs text-muted">
      {p.isVegan ? <span className="inline-flex items-center gap-1 text-success"><VegMark /> <span aria-hidden>🌱</span> Vegan</span> : p.isVegetarian ? <span className="inline-flex items-center gap-1 text-success"><VegMark /> <span aria-hidden>🥬</span> Vegetarian</span> : p.proteins?.length ? <VegMark nonVeg /> : null}
      <ProteinIcons proteins={p.proteins} />
      {!!p.allergens?.length && <span title="Allergens">Contains: {p.allergens.join(', ')}</span>}
    </span>
  );
}

export function ProductCard({ p, onAdd, index = 0 }: { p: any; onAdd?: (p: any) => void; index?: number }) {
  const price = Number(p.discountPrice ?? p.price);
  const orderable = p.orderable !== false && p.isAvailable !== false;
  return (
    <motion.article
      initial={{ opacity: 0, y: 18 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, margin: '-40px' }} transition={{ delay: Math.min(index, 6) * 0.05, duration: 0.35 }}
      whileHover={{ y: -3 }} className="group flex flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-card"
    >
      <Link to={`/menu/${p.slug}`} className="relative block overflow-hidden" aria-label={`View ${p.name}`}>
        <FoodImage src={p.images?.[0]?.url} alt={p.images?.[0]?.alt} name={p.name} className="aspect-[4/3] w-full transition-transform duration-500 group-hover:scale-105" />
        {p.isChefPick && <span className="absolute left-2 top-2 rounded-full bg-accent px-2.5 py-0.5 text-xs font-semibold text-accent-fg">Chef’s pick</span>}
        {!orderable && <span className="absolute inset-0 grid place-items-center bg-black/55 text-sm font-medium text-white">Unavailable right now</span>}
      </Link>
      <div className="flex flex-1 flex-col gap-1 p-4">
        <h3 className="font-display text-lg leading-snug"><Link to={`/menu/${p.slug}`} className="hover:underline">{p.name}</Link></h3>
        {p.description && <p className="line-clamp-2 text-sm text-muted">{p.description}</p>}
        <DietBadges p={p} />
        <div className="mt-auto flex items-center justify-between pt-3">
          <div>
            <span className="font-semibold">{p.variants?.length ? 'From ' : ''}{money(price)}</span>
            {p.discountPrice != null && <span className="ml-2 text-sm text-muted line-through">{money(p.price)}</span>}
          </div>
          {onAdd && <button disabled={!orderable} onClick={() => onAdd(p)} aria-label={`Add ${p.name}`} className="grid h-10 w-10 place-items-center rounded-full bg-brand text-brand-fg transition-transform hover:scale-105 active:scale-95 disabled:opacity-40"><Plus className="h-5 w-5" /></button>}
        </div>
      </div>
    </motion.article>
  );
}
