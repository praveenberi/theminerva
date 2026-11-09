import { useParams, Link } from 'react-router-dom';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Heart } from 'lucide-react';
import { ErrorState, Skeleton, useToast } from '@/components/ui';
import { DietBadges, FoodImage, ProductCard } from '@/components/Food';
import { ProductOptions, useAddToCart } from '@/components/ProductModal';
import { api, errorMessage } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { getLang, useJsonLd, useSeo } from '@/lib/hooks';
import { money } from '@/lib/format';
import { useMemo, useState } from 'react';

export default function Product() {
  const { slug } = useParams();
  const { user } = useAuth();
  const toast = useToast();
  const [fav, setFav] = useState(false);
  const q = useQuery({ queryKey: ['product', slug, getLang()], queryFn: () => api(`/api/public/products/${slug}`, { query: { lang: getLang() } }) });
  const { add, modal } = useAddToCart();
  const p = q.data;
  useSeo(p?.name ?? 'Dish', p?.description ?? undefined, p?.images?.[0]?.url);
  const ld = useMemo(() => p && ({ '@context': 'https://schema.org', '@type': 'MenuItem', name: p.name, description: p.description ?? undefined, image: p.images?.[0]?.url, offers: { '@type': 'Offer', price: Number(p.discountPrice ?? p.price).toFixed(2), priceCurrency: 'SGD' }, suitableForDiet: p.isVegan ? 'https://schema.org/VeganDiet' : p.isVegetarian ? 'https://schema.org/VegetarianDiet' : undefined }), [p]);
  useJsonLd('ld-menuitem', ld);
  const toggleFav = useMutation({ mutationFn: () => api(`/api/customers/me/favourites/${p.id}`, { method: 'POST', body: {} }), onSuccess: (r) => { setFav(r.favourite); toast('success', r.favourite ? 'Saved to favourites' : 'Removed from favourites'); }, onError: (e) => toast('error', errorMessage(e)) });

  if (q.isLoading) return <div className="mx-auto max-w-5xl p-4"><Skeleton className="h-96" /></div>;
  if (q.error || !p) return <div className="mx-auto max-w-xl p-8"><ErrorState error={q.error ?? new Error('Dish not found')} /><Link to="/menu" className="mt-4 inline-block underline">Back to the menu</Link></div>;

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <nav aria-label="Breadcrumb" className="mb-4 text-sm text-muted"><Link to="/menu" className="hover:underline">Menu</Link> / <Link to={`/menu?category=${p.category.slug}`} className="hover:underline">{p.category.name}</Link></nav>
      <div className="grid gap-8 md:grid-cols-2">
        <div className="space-y-3">
          <FoodImage src={p.images[0]?.url} alt={p.images[0]?.alt} name={p.name} className="aspect-square w-full rounded-2xl" priority />
          {p.images.length > 1 && <div className="flex gap-2">{p.images.slice(1).map((i: any) => <img key={i.id} src={i.url} alt={i.alt ?? p.name} loading="lazy" className="h-20 w-20 rounded-xl object-cover" />)}</div>}
        </div>
        <div>
          <div className="flex items-start justify-between gap-3"><h1 className="text-4xl">{p.name}</h1>
            {user?.kind === 'customer' && <button aria-pressed={fav} aria-label="Favourite" onClick={() => toggleFav.mutate()} className="rounded-full p-2 hover:bg-surface-2"><Heart className={`h-6 w-6 ${fav ? 'fill-danger text-danger' : ''}`} /></button>}
          </div>
          <p className="mt-2 text-2xl font-semibold">{money(p.discountPrice ?? p.price)} {p.discountPrice != null && <span className="text-base font-normal text-muted line-through">{money(p.price)}</span>}</p>
          <div className="mt-2"><DietBadges p={p} /></div>
          <p className="mt-1 text-sm text-muted">Ready in about {p.prepMinutes} min</p>
          <div className="mt-6 rounded-2xl border border-border p-4">
            {p.isAvailable ? <ProductOptions p={p} onDone={() => {}} /> : <p className="text-sm text-muted">This dish is unavailable right now.</p>}
          </div>
          {p.reviews.length > 0 && <div className="mt-8"><h2 className="mb-2 text-xl">Reviews</h2><ul className="space-y-3">{p.reviews.map((r: any) => <li key={r.id} className="text-sm"><span className="text-accent">{'★'.repeat(r.rating)}</span> <strong>{r.authorName}</strong><p className="text-muted">{r.comment}</p></li>)}</ul></div>}
        </div>
      </div>
      {p.recommendations.length > 0 && (
        <section className="mt-14"><h2 className="mb-4 text-2xl">Often ordered together</h2><div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">{p.recommendations.map((r: any, i: number) => <ProductCard key={r.id} p={r} onAdd={add} index={i} />)}</div></section>
      )}
      {modal}
    </div>
  );
}
