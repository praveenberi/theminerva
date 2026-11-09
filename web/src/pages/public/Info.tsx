import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Mail, MapPin, MessageCircle, Phone } from 'lucide-react';
import { Button, Card, EmptyState, QueryBoundary, Skeleton } from '@/components/ui';
import { HoursList } from '@/pages/public/Home';
import { api } from '@/lib/api';
import { useHome, useSeo } from '@/lib/hooks';
import { money } from '@/lib/format';

const POLICY_KEYS = { privacy: 'policy.privacy', terms: 'policy.terms', refunds: 'policy.refunds' } as const;

export default function Info({ page }: { page: 'about' | 'gallery' | 'offers' | 'loyalty' | 'contact' | 'privacy' | 'terms' | 'refunds' | 'notfound' }) {
  const home = useHome();
  const r = home.data?.restaurant;
  const titles: Record<string, string> = { about: `About ${r?.name ?? 'The Minerva'}`, gallery: 'Gallery', offers: 'Offers & promotions', loyalty: 'Loyalty & rewards', contact: 'Contact us', privacy: 'Privacy policy', terms: 'Terms & conditions', refunds: 'Refund & cancellation policy', notfound: 'Page not found' };
  useSeo(titles[page]);

  if (page === 'notfound') return <div className="mx-auto max-w-lg px-4 py-24 text-center"><h1 className="text-5xl">404</h1><p className="mt-2 text-muted">We couldn’t find that page.</p><Link to="/"><Button className="mt-6">Back home</Button></Link></div>;
  if (page === 'privacy' || page === 'terms' || page === 'refunds') return <Policy k={POLICY_KEYS[page]} />;

  return (
    <div className="mx-auto max-w-5xl px-4 py-10">
      <h1 className="text-4xl">{titles[page]}</h1>
      <div className="mt-8">
        <QueryBoundary q={home}>
          {(d) => {
            if (page === 'about') {
              const about = d.content['home.about'];
              const paras: string[] = about?.paragraphs ?? [d.restaurant.story, d.restaurant.description].filter(Boolean);
              return paras.length ? <div className="max-w-2xl space-y-4 text-lg leading-relaxed text-muted">{paras.map((t, i) => <p key={i}>{t}</p>)}</div> : <EmptyState title="Our story is coming soon" />;
            }
            if (page === 'gallery') return d.gallery.length ? <div className="columns-2 gap-3 md:columns-3">{d.gallery.map((g: any) => <img key={g.id} src={g.url} alt={g.alt} loading="lazy" decoding="async" className="mb-3 w-full rounded-xl" />)}</div> : <EmptyState title="Photos coming soon" />;
            if (page === 'offers') return d.banners.length ? <div className="grid gap-4 sm:grid-cols-2">{d.banners.map((b: any) => <Card key={b.id} className="p-5"><h2 className="text-2xl">{b.title}</h2>{b.subtitle && <p className="mt-1 text-muted">{b.subtitle}</p>}<Link to={b.linkUrl || '/menu'}><Button className="mt-4" variant="outline">Order now</Button></Link></Card>)}</div> : <EmptyState title="No offers right now">Sign in to see rewards and member-only offers.</EmptyState>;
            if (page === 'loyalty') return <Loyalty enabled={d.config.loyaltyEnabled} />;
            return (
              <div className="grid gap-8 md:grid-cols-2">
                <div className="space-y-4">
                  {d.restaurant.address && <p className="flex gap-3"><MapPin className="mt-1 h-5 w-5 shrink-0 text-accent" /><span className="whitespace-pre-line">{d.restaurant.address}</span></p>}
                  {d.restaurant.phone && <p className="flex gap-3"><Phone className="h-5 w-5 text-accent" /><a href={`tel:${d.restaurant.phone}`} className="hover:underline">{d.restaurant.phone}</a></p>}
                  {d.restaurant.email && <p className="flex gap-3"><Mail className="h-5 w-5 text-accent" /><a href={`mailto:${d.restaurant.email}`} className="hover:underline">{d.restaurant.email}</a></p>}
                  {d.restaurant.whatsapp && <p className="flex gap-3"><MessageCircle className="h-5 w-5 text-accent" /><a href={`https://wa.me/${d.restaurant.whatsapp.replace(/\D/g, '')}`} target="_blank" rel="noreferrer" className="hover:underline">Message us on WhatsApp</a></p>}
                  {!d.restaurant.address && !d.restaurant.phone && !d.restaurant.email && <p className="text-muted">Contact details will be published soon.</p>}
                  <div className="pt-4"><h2 className="mb-3 text-xl">Opening hours</h2><HoursList hours={d.restaurant.openingHours} /></div>
                </div>
                {d.restaurant.mapEmbedUrl && /^https:\/\/(www\.)?google\.com\/maps\/embed/.test(d.restaurant.mapEmbedUrl) && <iframe title="Map" src={d.restaurant.mapEmbedUrl} loading="lazy" className="h-80 w-full rounded-2xl border border-border" />}
              </div>
            );
          }}
        </QueryBoundary>
      </div>
    </div>
  );
}

function Policy({ k }: { k: string }) {
  const q = useQuery({ queryKey: ['content', k], queryFn: () => api(`/api/public/content/${k}`) });
  return (
    <div className="mx-auto max-w-3xl px-4 py-10">
      {q.isLoading ? <Skeleton className="h-64" /> : (
        <QueryBoundary q={q}>{(d) => (<><h1 className="text-4xl">{d.title}</h1><div className="mt-6 space-y-4 leading-relaxed text-muted">{(d.paragraphs ?? []).map((p: string, i: number) => <p key={i}>{p}</p>)}</div></>)}</QueryBoundary>
      )}
    </div>
  );
}

function Loyalty({ enabled }: { enabled: boolean }) {
  if (!enabled) return <EmptyState title="Our rewards programme is not active at the moment" />;
  return (
    <div className="space-y-6">
      <p className="max-w-2xl text-lg text-muted">Earn points on every order, unlock membership tiers and redeem points for vouchers. Refer a friend and you both benefit.</p>
      <div className="grid gap-4 sm:grid-cols-3">
        {[['Earn', 'Points are added when your order is completed.'], ['Level up', 'Higher tiers earn points faster.'], ['Redeem', 'Turn points into a voucher at checkout.']].map(([t, d]) => <Card key={t} className="p-5"><h2 className="text-xl">{t}</h2><p className="mt-1 text-sm text-muted">{d}</p></Card>)}
      </div>
      <div className="flex gap-3"><Link to="/register"><Button>Join now</Button></Link><Link to="/account/loyalty"><Button variant="outline">View my points</Button></Link></div>
    </div>
  );
}
void money;
