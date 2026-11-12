import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { motion, useScroll, useTransform } from 'motion/react';
import { useMutation } from '@tanstack/react-query';
import { ArrowRight, CalendarDays, Clock, MapPin, Quote, Star } from 'lucide-react';
import { Button, Input, QueryBoundary, Skeleton, useToast } from '@/components/ui';
import { FoodImage, ProductCard } from '@/components/Food';
import { useAddToCart } from '@/components/ProductModal';
import { useHome, useJsonLd, useSeo } from '@/lib/hooks';
import { api, errorMessage } from '@/lib/api';
import { WEEKDAYS } from '@/lib/format';
import { DEFAULT_SLIDES, HeroBackground, normalizeSlide, type HeroSlide } from '@/components/HeroSlides';

export function Section({ title, kicker, action, children, className = '' }: { title: string; kicker?: string; action?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={`mx-auto max-w-6xl px-4 py-14 ${className}`}>
      <motion.div initial={{ opacity: 0, y: 16 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} className="mb-8 flex items-end justify-between gap-4">
        <div>{kicker && <p className="mb-1 text-xs font-semibold uppercase tracking-[.2em] text-accent">{kicker}</p>}<h2 className="text-3xl sm:text-4xl">{title}</h2></div>
        {action}
      </motion.div>
      {children}
    </section>
  );
}

export function HoursList({ hours }: { hours: Record<string, { open?: string; close?: string; closed?: boolean }> | null }) {
  const entries = WEEKDAYS.map((d) => [d, hours?.[d]] as const);
  if (!entries.some(([, h]) => h?.open)) return <p className="text-sm text-muted">Opening hours will be published soon.</p>;
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
      {entries.map(([d, h]) => (<div key={d} className="contents"><dt className="font-medium capitalize">{d}</dt><dd className="text-muted">{h && !h.closed && h.open ? `${h.open} – ${h.close}` : 'Closed'}</dd></div>))}
    </dl>
  );
}

export default function Home() {
  const q = useHome();
  const { add, modal } = useAddToCart();
  const r = q.data?.restaurant;
  useSeo(r?.seo?.title || 'The Minerva | Indian, Italian & Mexican Restaurant Singapore', r?.seo?.description || r?.description || 'Discover The Minerva, a restaurant in Singapore serving authentic Indian, Hyderabadi and Andhra cuisine alongside Italian and Mexican favourites. Enjoy vegetarian and non-vegetarian dishes, refreshing drinks and memorable dining.', r?.seo?.ogImage || r?.heroImageUrl || `${location.origin}/hero-1.jpg`);
  const ld = useMemo(() => q.data ? ({
    '@context': 'https://schema.org', '@type': 'Restaurant', name: r.name, description: r.description ?? undefined, url: location.origin,
    telephone: r.phone ?? undefined, email: r.email ?? undefined, image: r.heroImageUrl ?? `${location.origin}/hero-1.jpg`, servesCuisine: ['Indian', 'Hyderabadi', 'Andhra', 'Italian', 'Mexican'],
    address: r.address ? { '@type': 'PostalAddress', streetAddress: r.address, addressLocality: 'Singapore', addressCountry: 'SG' } : undefined,
    geo: r.latitude != null ? { '@type': 'GeoCoordinates', latitude: r.latitude, longitude: r.longitude } : undefined,
    hasMenu: `${location.origin}/menu`, acceptsReservations: q.data.config.reservationsEnabled,
    openingHoursSpecification: Object.entries(r.openingHours ?? {}).filter(([, h]: any) => h?.open && !h.closed).map(([d, h]: any) => ({ '@type': 'OpeningHoursSpecification', dayOfWeek: d.charAt(0).toUpperCase() + d.slice(1), opens: h.open, closes: h.close })),
    aggregateRating: q.data.reviews.count ? { '@type': 'AggregateRating', ratingValue: Number(q.data.reviews.average).toFixed(1), reviewCount: q.data.reviews.count } : undefined,
    sameAs: Object.values(r.social ?? {}).filter(Boolean),
  }) : null, [q.data, r]);
  useJsonLd('ld-restaurant', ld);

  const heroRef = useState<HTMLElement | null>(null);
  const { scrollY } = useScroll();
  const y = useTransform(scrollY, [0, 600], [0, 120]);
  const fade = useTransform(scrollY, [0, 500], [1, 0.2]);
  void heroRef;
  // hero slideshow: advances by itself every 6s, pauses while hovered / tab hidden, and stays still for reduced-motion users
  // images: the ones set in Admin → Website content → Homepage hero, else the single hero image from Settings, else the built-in pair
  const saved: any[] = (q.data?.content?.['home.hero']?.slides ?? []).filter((x: any) => x?.url);
  const slides: HeroSlide[] = saved.length ? saved.map(normalizeSlide) : r?.heroImageUrl ? [normalizeSlide({ url: r.heroImageUrl, y: 35, fit: 'contain' })] : DEFAULT_SLIDES;
  const [slide, setSlide] = useState(0);
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (slides.length < 2 || paused || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const t = setInterval(() => { if (!document.hidden) setSlide((n) => (n + 1) % slides.length); }, 6000);
    return () => clearInterval(t);
  }, [slides.length, paused]);
  const cur = slides[Math.min(slide, slides.length - 1)];

  if (q.isLoading) return <div className="mx-auto max-w-6xl space-y-6 px-4 py-10"><Skeleton className="h-[60vh]" /><Skeleton className="h-40" /></div>;
  if (q.error) return <div className="mx-auto max-w-xl p-10"><QueryBoundary q={q}>{() => null}</QueryBoundary></div>;
  const d = q.data;
  const hero = d.content['home.hero'];
  const about = d.content['home.about'];

  return (
    <>
      <section className="relative isolate overflow-hidden bg-brand text-brand-fg" onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}>
        <motion.div style={{ y }} className="absolute inset-0 -z-10">
          <HeroBackground slides={slides} index={slide} />
          <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/30 to-black/10" />
        </motion.div>
        {slides.length > 1 && (
          <div className="absolute bottom-5 left-1/2 z-10 flex -translate-x-1/2 gap-2">
            {slides.map((_, i) => <button key={i} aria-label={`Show slide ${i + 1}`} aria-current={i === slide} onClick={() => setSlide(i)} className={`h-2 rounded-full transition-all ${i === slide ? 'w-6 bg-accent' : 'w-2 bg-white/50 hover:bg-white/80'}`} />)}
          </div>
        )}
        <motion.div style={{ opacity: fade }} className="mx-auto flex min-h-[85vh] max-w-6xl flex-col justify-end px-4 pb-16 pt-24">
          {!cur?.hideText && (<>
          <motion.p initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }} className="mb-4 text-xs font-semibold uppercase tracking-[.3em] text-accent">{hero?.kicker ?? 'Welcome to'}</motion.p>
          <motion.h1 initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2, duration: 0.7 }} className="max-w-3xl text-5xl leading-[1.05] sm:text-7xl">{hero?.headline ?? r.name}</motion.h1>
          <motion.p initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.4 }} className="mt-5 max-w-xl whitespace-pre-line text-lg text-brand-fg/85">{hero?.text ?? r.tagline ?? r.description ?? 'Order online or reserve your table.'}</motion.p>
          </>)}
          <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.55 }} className="mt-8 flex flex-wrap gap-3">
            <Link to="/menu"><Button size="lg" variant="accent">Order online <ArrowRight className="h-4 w-4" /></Button></Link>
            {d.config.reservationsEnabled && <Link to="/reservations"><Button size="lg" variant="outline" className="border-white/40 bg-white/10 text-white hover:bg-white/20"><CalendarDays className="h-4 w-4" /> Book a table</Button></Link>}
            <Link to="/menu"><Button size="lg" variant="ghost" className="text-white hover:bg-white/10">Explore the menu</Button></Link>
          </motion.div>
        </motion.div>
      </section>

      <section className="mx-auto max-w-3xl px-4 pt-14 text-center">
        <h2 className="text-3xl sm:text-4xl">A World of Indian, Italian and Mexican Cuisine in Singapore</h2>
        <p className="mt-4 text-muted">At {r.name}, we bring together authentic Indian, Hyderabadi and Andhra flavours with delicious Italian and vibrant Mexican specialities — vegetarian and non-vegetarian dishes, refreshing drinks and memorable dining.</p>
      </section>

      {d.banners.length > 0 && (
        <div className="border-b border-border bg-accent/15">
          <div className="mx-auto flex max-w-6xl gap-6 overflow-x-auto px-4 py-3 text-sm">
            {d.banners.map((b: any) => (<Link key={b.id} to={b.linkUrl || '/offers'} className="flex shrink-0 items-center gap-2 font-medium"><Star className="h-4 w-4 text-accent" />{b.title}{b.subtitle && <span className="text-muted">— {b.subtitle}</span>}</Link>))}
          </div>
        </div>
      )}

      {d.categories.length > 0 && (
        <Section title="Explore the menu" kicker="Categories">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {d.categories.map((c: any, i: number) => (
              <motion.div key={c.id} initial={{ opacity: 0, scale: 0.96 }} whileInView={{ opacity: 1, scale: 1 }} viewport={{ once: true }} transition={{ delay: i * 0.05 }} whileHover={{ y: -4 }}>
                <Link to={`/menu?category=${c.slug}`} className="relative block overflow-hidden rounded-2xl">
                  <FoodImage src={c.imageUrl} name={c.name} className="aspect-[4/3] w-full" />
                  <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent p-3 font-display text-lg text-white">{c.name}</span>
                </Link>
              </motion.div>
            ))}
          </div>
        </Section>
      )}

      {d.bestSellers.length > 0 && (
        <Section title="Best sellers" kicker="Most loved" action={<Link to="/menu" className="text-sm font-medium underline-offset-4 hover:underline">Full menu</Link>}>
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">{d.bestSellers.slice(0, 6).map((p: any, i: number) => <ProductCard key={p.id} p={p} onAdd={add} index={i} />)}</div>
        </Section>
      )}

      {(d.chefPicks.length > 0 || d.featured.length > 0) && (
        <div className="bg-surface-2">
          <Section title={d.chefPicks.length ? 'Chef’s recommendations' : 'Featured dishes'} kicker="From the kitchen">
            <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">{(d.chefPicks.length ? d.chefPicks : d.featured).slice(0, 6).map((p: any, i: number) => <ProductCard key={p.id} p={p} onAdd={add} index={i} />)}</div>
          </Section>
        </div>
      )}

      <Section title={about?.title ?? `About ${r.name}`} kicker="Our story">
        <div className="grid items-center gap-8 md:grid-cols-2">
          <motion.div initial={{ opacity: 0, x: -24 }} whileInView={{ opacity: 1, x: 0 }} viewport={{ once: true }} className="space-y-4 text-lg leading-relaxed text-muted">
            {(about?.paragraphs ?? (r.story || r.description ? [r.story || r.description] : [])).map((t: string, i: number) => <p key={i}>{t}</p>)}
            {!about?.paragraphs && !r.story && !r.description && <p>Our story will be shared here soon.</p>}
            <Link to="/about" className="inline-flex items-center gap-1 text-base font-medium text-fg underline-offset-4 hover:underline">Read more <ArrowRight className="h-4 w-4" /></Link>
          </motion.div>
          <motion.div initial={{ opacity: 0, clipPath: 'inset(0 100% 0 0)' }} whileInView={{ opacity: 1, clipPath: 'inset(0 0% 0 0)' }} viewport={{ once: true }} transition={{ duration: 0.9, ease: 'easeOut' }}>
            <FoodImage src={about?.imageUrl ?? d.gallery[0]?.url} alt={d.gallery[0]?.alt} name={r.name} className="aspect-[5/4] w-full rounded-2xl" />
          </motion.div>
        </div>
      </Section>

      {d.gallery.length > 0 && (
        <Section title="Gallery" kicker="A taste of the experience" action={<Link to="/gallery" className="text-sm font-medium hover:underline">See all</Link>}>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {d.gallery.slice(0, 8).map((g: any, i: number) => (
              <motion.div key={g.id} initial={{ opacity: 0 }} whileInView={{ opacity: 1 }} viewport={{ once: true }} transition={{ delay: i * 0.04 }} className={i % 5 === 0 ? 'row-span-2' : ''}>
                <img src={g.url} alt={g.alt} loading="lazy" decoding="async" className="h-full w-full rounded-xl object-cover" />
              </motion.div>
            ))}
          </div>
        </Section>
      )}

      {(d.testimonials.length > 0 || d.reviews.count > 0) && (
        <div className="bg-brand text-brand-fg">
          <Section title="What guests say" kicker="Reviews">
            {d.reviews.count > 0 && <p className="mb-6 flex items-center gap-2 text-sm"><Star className="h-4 w-4 fill-accent text-accent" /> {Number(d.reviews.average).toFixed(1)} from {d.reviews.count} reviews</p>}
            <div className="grid gap-4 md:grid-cols-3">
              {d.testimonials.slice(0, 6).map((t: any) => (
                <motion.figure key={t.id} initial={{ opacity: 0, y: 16 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} className="rounded-2xl bg-white/10 p-5">
                  <Quote className="mb-2 h-5 w-5 text-accent" aria-hidden />
                  <blockquote className="text-sm leading-relaxed">{t.quote}</blockquote>
                  <figcaption className="mt-3 flex items-center justify-between text-xs"><span className="font-medium">{t.author}</span><span aria-label={`${t.rating} stars`}>{'★'.repeat(t.rating)}</span></figcaption>
                </motion.figure>
              ))}
            </div>
            <div className="mt-6 flex flex-wrap gap-4 text-sm">
              {d.reviews.googleUrl && <a href={d.reviews.googleUrl} target="_blank" rel="noreferrer" className="underline">Read our Google reviews</a>}
              <Link to="/feedback" className="underline">Share your experience</Link>
            </div>
          </Section>
        </div>
      )}

      <Section title="Visit us" kicker="Hours & location">
        <div className="grid gap-8 md:grid-cols-2">
          <div className="space-y-6">
            <div><h3 className="mb-3 flex items-center gap-2 text-lg"><Clock className="h-5 w-5 text-accent" /> Opening hours</h3><HoursList hours={r.openingHours} /></div>
            <div><h3 className="mb-2 flex items-center gap-2 text-lg"><MapPin className="h-5 w-5 text-accent" /> Find us</h3><p className="whitespace-pre-line text-sm text-muted">{r.address || 'Address coming soon.'}</p>{r.phone && <p className="mt-1 text-sm">{r.phone}</p>}</div>
          </div>
          {r.mapEmbedUrl && /^https:\/\/(www\.)?google\.com\/maps\/embed/.test(r.mapEmbedUrl)
            ? <iframe title="Map to the restaurant" src={r.mapEmbedUrl} loading="lazy" referrerPolicy="no-referrer-when-downgrade" className="h-72 w-full rounded-2xl border border-border" />
            : <div className="grid h-72 place-items-center rounded-2xl border border-dashed border-border text-sm text-muted">Map will appear once configured.</div>}
        </div>
      </Section>

      <Newsletter />
      {modal}
    </>
  );
}

function Newsletter() {
  const [email, setEmail] = useState('');
  const toast = useToast();
  const m = useMutation({ mutationFn: () => api('/api/public/newsletter', { body: { email } }), onSuccess: () => { toast('success', 'Subscribed — thank you!'); setEmail(''); }, onError: (e) => toast('error', errorMessage(e)) });
  return (
    <div className="border-t border-border bg-surface-2">
      <div className="mx-auto flex max-w-6xl flex-col items-start gap-4 px-4 py-10 md:flex-row md:items-center md:justify-between">
        <div><h2 className="text-2xl">Stay in the loop</h2><p className="text-sm text-muted">News and offers. Unsubscribe any time.</p></div>
        <form className="flex w-full max-w-md gap-2" onSubmit={(e) => { e.preventDefault(); m.mutate(); }}>
          <Input type="email" required placeholder="you@example.com" aria-label="Email address" value={email} onChange={(e) => setEmail(e.target.value)} />
          <Button loading={m.isPending}>Subscribe</Button>
        </form>
      </div>
    </div>
  );
}
