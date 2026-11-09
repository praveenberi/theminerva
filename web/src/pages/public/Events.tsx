import { Link } from 'react-router-dom';
import { Button, EmptyState, QueryBoundary } from '@/components/ui';
import { FoodImage } from '@/components/Food';
import { useHome, useSeo } from '@/lib/hooks';
import { dateTime } from '@/lib/format';

export default function Events() {
  useSeo('Events & private dining', 'Host your celebration at The Minerva.');
  const q = useHome();
  return (
    <div className="mx-auto max-w-5xl px-4 py-10">
      <h1 className="text-4xl">Events & private dining</h1>
      <p className="mt-2 max-w-2xl text-muted">Celebrations, corporate dinners and private tables. Send us a request and our team will confirm the details with you.</p>
      <Link to="/reservations"><Button className="mt-5">Make an enquiry</Button></Link>
      <div className="mt-10">
        <QueryBoundary q={q}>
          {(d) => d.events.length === 0 ? <EmptyState title="No upcoming events listed">Check back soon, or enquire about a private booking.</EmptyState> : (
            <div className="grid gap-6 md:grid-cols-2">{d.events.map((e: any) => (
              <article key={e.id} className="overflow-hidden rounded-2xl border border-border bg-surface shadow-card">
                <FoodImage src={e.imageUrl} name={e.title} className="aspect-video w-full" />
                <div className="p-5"><h2 className="text-2xl">{e.title}</h2>{e.eventDate && <p className="text-sm text-accent">{dateTime(e.eventDate)}</p>}{e.description && <p className="mt-2 text-sm text-muted">{e.description}</p>}</div>
              </article>))}</div>
          )}
        </QueryBoundary>
      </div>
    </div>
  );
}
