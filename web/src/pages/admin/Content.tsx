import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ImagePlus, Plus } from 'lucide-react';
import { Badge, Button, Card, ConfirmButton, Field, Input, Modal, QueryBoundary, Select, Tabs, Textarea, useToast } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { useSeo } from '@/lib/hooks';
import { DEFAULT_SLIDES, HeroSlidesEditor, normalizeSlide } from '@/components/HeroSlides';

type Tab = 'pages' | 'gallery' | 'testimonials' | 'events' | 'reviews';
const BLOCKS: Record<string, { label: string; fields: Array<[string, string, 'text' | 'area' | 'paras' | 'image' | 'slides']> }> = {
  'home.hero': { label: 'Homepage hero', fields: [['kicker', 'Small heading', 'text'], ['headline', 'Headline', 'text'], ['text', 'Intro text', 'area'], ['slides', 'Homepage pictures (rotate automatically)', 'slides']] },
  'home.about': { label: 'About / restaurant story', fields: [['title', 'Section title', 'text'], ['paragraphs', 'Story (separate paragraphs with a blank line)', 'paras'], ['imageUrl', 'Image', 'image']] },
  'policy.privacy': { label: 'Privacy policy', fields: [['paragraphs', 'Policy text (blank line between paragraphs)', 'paras']] },
  'policy.terms': { label: 'Terms & conditions', fields: [['paragraphs', 'Text (blank line between paragraphs)', 'paras']] },
  'policy.refunds': { label: 'Refund & cancellation policy', fields: [['paragraphs', 'Text (blank line between paragraphs)', 'paras']] },
};

export default function Content() {
  useSeo('Website content');
  const [tab, setTab] = useState<Tab>('pages');
  return <div className="space-y-4"><Tabs value={tab} onChange={setTab} tabs={[{ id: 'pages', label: 'Pages & text' }, { id: 'gallery', label: 'Gallery' }, { id: 'testimonials', label: 'Testimonials' }, { id: 'events', label: 'Events' }, { id: 'reviews', label: 'Feedback moderation' }]} />
    {tab === 'pages' ? <Pages /> : tab === 'gallery' ? <Gallery /> : tab === 'testimonials' ? <Testimonials /> : tab === 'events' ? <Events /> : <Reviews />}</div>;
}

export function useUpload() {
  const toast = useToast();
  return async (f: File) => { try { const fd = new FormData(); fd.append('file', f); return (await api('/api/uploads', { body: fd })).url as string; } catch (e) { toast('error', errorMessage(e)); return null; } };
}

function Pages() {
  const qc = useQueryClient(); const toast = useToast(); const upload = useUpload();
  const q = useQuery({ queryKey: ['blocks'], queryFn: () => api('/api/cms/blocks') });
  const [key, setKey] = useState('home.hero');
  const [draft, setDraft] = useState<any>(null);
  const spec = BLOCKS[key];
  const row = q.data?.find((b: any) => b.key === key);
  const cur = draft ?? { title: (row?.draft?.title ?? row?.title) || '', ...((row?.draft?.body ?? row?.body) || {}) };
  const toBody = () => { const body: any = {}; for (const [f, , kind] of spec.fields) { const v = cur[f]; if (kind === 'slides') { const sl = (Array.isArray(v) ? v : []).filter((x: any) => x?.url).map(normalizeSlide); if (sl.length) body[f] = sl; } else if (kind === 'paras') body[f] = Array.isArray(v) ? v : String(v ?? '').split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean); else if (v) body[f] = v; } if (cur.title && !spec.fields.some(([f]) => f === 'title')) body.title = cur.title; return body; };
  const save = useMutation({ mutationFn: (publish: boolean) => api(`/api/cms/blocks/${key}`, { method: 'PUT', body: { title: key.startsWith('policy') ? BLOCKS[key].label : cur.title || undefined, body: toBody(), publish } }), onSuccess: (_r, publish) => { toast('success', publish ? 'Published to the website' : 'Draft saved (not live)'); setDraft(null); qc.invalidateQueries({ queryKey: ['blocks'] }); qc.invalidateQueries({ queryKey: ['home'] }); }, onError: (e) => toast('error', errorMessage(e)) });
  const val = (f: string, kind: string) => (kind === 'paras' ? (Array.isArray(cur[f]) ? cur[f].join('\n\n') : cur[f] ?? '') : cur[f] ?? '');
  return (
    <QueryBoundary q={q}>{() => (
      <div className="grid gap-6 lg:grid-cols-[220px_1fr]">
        <ul className="space-y-1">{Object.entries(BLOCKS).map(([k, b]) => { const r = q.data.find((x: any) => x.key === k); return <li key={k}><button onClick={() => { setKey(k); setDraft(null); }} className={`flex w-full items-center justify-between rounded-xl px-3 py-2 text-left text-sm ${key === k ? 'bg-brand text-brand-fg' : 'hover:bg-surface-2'}`}>{b.label}{r?.draft && <Badge tone="warn">draft</Badge>}</button></li>; })}</ul>
        <Card className="space-y-4 p-5"><h2 className="text-xl">{spec.label}</h2>
          {row?.draft && !draft && <p className="rounded-lg bg-warn/10 p-2 text-sm text-warn">Showing an unpublished draft.</p>}
          {spec.fields.map(([f, label, kind]) => kind === 'slides' ? (
            <div key={f} className="space-y-2"><p className="text-sm font-medium">{label}</p>
              {!Array.isArray(cur[f]) && <p className="rounded-lg bg-surface-2 p-2 text-xs text-muted">The website is showing its built-in pictures. Add your own below, then press Publish.</p>}
              <HeroSlidesEditor value={Array.isArray(cur[f]) ? cur[f].map(normalizeSlide) : DEFAULT_SLIDES} onChange={(v) => setDraft({ ...cur, [f]: v })} /></div>
          ) : (
            <Field key={f} label={label}>{(id) => kind === 'text' ? <Input id={id} value={val(f, kind)} onChange={(e) => setDraft({ ...cur, [f]: e.target.value })} /> : kind === 'image' ? (
              <div className="flex items-center gap-3">{cur[f] && <img src={cur[f]} alt="" className="h-16 w-16 rounded-lg object-cover" />}<label className="inline-flex cursor-pointer items-center gap-2 rounded-xl border border-border px-3 py-2 text-sm hover:bg-surface-2"><ImagePlus className="h-4 w-4" /> Upload<input type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" onChange={async (e) => { const u = e.target.files?.[0] && (await upload(e.target.files[0])); if (u) setDraft({ ...cur, [f]: u }); }} /></label></div>
            ) : <Textarea id={id} className={kind === 'paras' ? 'min-h-48' : ''} value={val(f, kind)} onChange={(e) => setDraft({ ...cur, [f]: e.target.value })} />}</Field>))}
          <div className="flex gap-2"><Button variant="outline" loading={save.isPending} onClick={() => save.mutate(false)}>Save draft</Button><Button loading={save.isPending} onClick={() => save.mutate(true)}>Publish</Button></div>
          <p className="text-xs text-muted">SEO titles, descriptions and social images are in Settings → Profile. {key.startsWith('policy') && 'Have policies reviewed by a legal adviser before launch.'}</p></Card>
      </div>)}</QueryBoundary>
  );
}

function Gallery() {
  const qc = useQueryClient(); const toast = useToast(); const upload = useUpload();
  const q = useQuery({ queryKey: ['cms-gallery'], queryFn: () => api('/api/cms/gallery') });
  const [alt, setAlt] = useState('');
  const refresh = () => { qc.invalidateQueries({ queryKey: ['cms-gallery'] }); qc.invalidateQueries({ queryKey: ['home'] }); };
  const add = useMutation({ mutationFn: (url: string) => api('/api/cms/gallery', { body: { url, alt } }), onSuccess: () => { setAlt(''); refresh(); toast('success', 'Photo added'); }, onError: (e) => toast('error', errorMessage(e)) });
  const del = useMutation({ mutationFn: (id: string) => api(`/api/cms/gallery/${id}`, { method: 'DELETE' }), onSuccess: refresh });
  const toggle = useMutation({ mutationFn: (g: any) => api(`/api/cms/gallery/${g.id}`, { method: 'PUT', body: { isPublished: !g.isPublished } }), onSuccess: refresh });
  return (<div className="space-y-4"><Card className="flex flex-wrap items-end gap-3 p-4"><Field label="Alt text (describe the photo)" className="min-w-64 flex-1">{(id) => <Input id={id} value={alt} onChange={(e) => setAlt(e.target.value)} />}</Field>
    <label className={`inline-flex cursor-pointer items-center gap-2 rounded-xl bg-brand px-4 py-2.5 text-sm font-medium text-brand-fg ${alt.trim() ? '' : 'pointer-events-none opacity-50'}`}><ImagePlus className="h-4 w-4" /> Upload photo<input type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" disabled={!alt.trim()} onChange={async (e) => { const u = e.target.files?.[0] && (await upload(e.target.files[0])); if (u) add.mutate(u); e.target.value = ''; }} /></label></Card>
    <QueryBoundary q={q} empty={(d) => d.length === 0}>{(d) => <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">{d.map((g: any) => <div key={g.id} className="space-y-1"><img src={g.url} alt={g.alt} className={`aspect-square w-full rounded-xl object-cover ${g.isPublished ? '' : 'opacity-40'}`} /><p className="truncate text-xs">{g.alt}</p><div className="flex justify-between text-xs"><button className="underline" onClick={() => toggle.mutate(g)}>{g.isPublished ? 'Hide' : 'Show'}</button><ConfirmButton size="sm" variant="ghost" className="h-6 px-1 text-danger" message="Delete this photo?" onConfirm={() => del.mutate(g.id)}>Delete</ConfirmButton></div></div>)}</div>}</QueryBoundary></div>);
}

function Testimonials() {
  const qc = useQueryClient(); const toast = useToast();
  const q = useQuery({ queryKey: ['cms-testimonials'], queryFn: () => api('/api/cms/testimonials') });
  const [f, setF] = useState<any>(null);
  const refresh = () => { qc.invalidateQueries({ queryKey: ['cms-testimonials'] }); qc.invalidateQueries({ queryKey: ['home'] }); };
  const save = useMutation({ mutationFn: (v: any) => { const b = { author: v.author, quote: v.quote, rating: Number(v.rating), isPublished: v.isPublished ?? true }; return v.id ? api(`/api/cms/testimonials/${v.id}`, { method: 'PUT', body: b }) : api('/api/cms/testimonials', { body: b }); }, onSuccess: () => { setF(null); refresh(); }, onError: (e) => toast('error', errorMessage(e)) });
  const del = useMutation({ mutationFn: (id: string) => api(`/api/cms/testimonials/${id}`, { method: 'DELETE' }), onSuccess: refresh });
  return (<div className="space-y-4"><Button onClick={() => setF({ author: '', quote: '', rating: 5 })}><Plus className="h-4 w-4" /> Testimonial</Button>
    <QueryBoundary q={q} empty={(d) => d.length === 0}>{(d) => <div className="grid gap-3 sm:grid-cols-2">{d.map((t: any) => <Card key={t.id} className="p-4 text-sm"><p>“{t.quote}”</p><p className="mt-2 flex justify-between"><b>{t.author} · {'★'.repeat(t.rating)}</b><span><Button size="sm" variant="ghost" onClick={() => setF(t)}>Edit</Button><ConfirmButton size="sm" variant="ghost" className="text-danger" message="Delete?" onConfirm={() => del.mutate(t.id)}>×</ConfirmButton></span></p></Card>)}</div>}</QueryBoundary>
    <Modal open={!!f} onClose={() => setF(null)} title="Testimonial">{f && <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); save.mutate(f); }}><Field label="Guest name">{(id) => <Input id={id} required value={f.author} onChange={(e) => setF({ ...f, author: e.target.value })} />}</Field><Field label="Quote">{(id) => <Textarea id={id} required value={f.quote} onChange={(e) => setF({ ...f, quote: e.target.value })} />}</Field><Field label="Rating">{(id) => <Select id={id} value={f.rating} onChange={(e) => setF({ ...f, rating: e.target.value })}>{[5, 4, 3, 2, 1].map((n) => <option key={n}>{n}</option>)}</Select>}</Field><div className="flex justify-end"><Button loading={save.isPending}>Save</Button></div></form>}</Modal></div>);
}

function Events() {
  const qc = useQueryClient(); const toast = useToast(); const upload = useUpload();
  const q = useQuery({ queryKey: ['cms-events'], queryFn: () => api('/api/cms/events') });
  const [f, setF] = useState<any>(null);
  const refresh = () => { qc.invalidateQueries({ queryKey: ['cms-events'] }); qc.invalidateQueries({ queryKey: ['home'] }); };
  const save = useMutation({ mutationFn: (v: any) => { const b = { title: v.title, description: v.description || null, imageUrl: v.imageUrl || null, eventDate: v.eventDate ? new Date(v.eventDate).toISOString() : null, isPublished: v.isPublished ?? true }; return v.id ? api(`/api/cms/events/${v.id}`, { method: 'PUT', body: b }) : api('/api/cms/events', { body: b }); }, onSuccess: () => { setF(null); refresh(); }, onError: (e) => toast('error', errorMessage(e)) });
  const del = useMutation({ mutationFn: (id: string) => api(`/api/cms/events/${id}`, { method: 'DELETE' }), onSuccess: refresh });
  return (<div className="space-y-4"><Button onClick={() => setF({ title: '' })}><Plus className="h-4 w-4" /> Event</Button>
    <QueryBoundary q={q} empty={(d) => d.length === 0}>{(d) => <div className="grid gap-3 sm:grid-cols-2">{d.map((e: any) => <Card key={e.id} className="flex items-start justify-between p-4"><div><p className="font-medium">{e.title}</p><p className="text-sm text-muted">{e.eventDate ? dateTime(e.eventDate) : 'No date'}</p></div><div><Button size="sm" variant="ghost" onClick={() => setF({ ...e, eventDate: e.eventDate?.slice(0, 16) ?? '' })}>Edit</Button><ConfirmButton size="sm" variant="ghost" className="text-danger" message="Delete?" onConfirm={() => del.mutate(e.id)}>×</ConfirmButton></div></Card>)}</div>}</QueryBoundary>
    <Modal open={!!f} onClose={() => setF(null)} title="Event">{f && <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); save.mutate(f); }}><Field label="Title">{(id) => <Input id={id} required value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />}</Field><Field label="Date & time">{(id) => <Input id={id} type="datetime-local" value={f.eventDate ?? ''} onChange={(e) => setF({ ...f, eventDate: e.target.value })} />}</Field><Field label="Description">{(id) => <Textarea id={id} value={f.description ?? ''} onChange={(e) => setF({ ...f, description: e.target.value })} />}</Field>
      <div className="flex items-center gap-3">{f.imageUrl && <img src={f.imageUrl} alt="" className="h-14 w-14 rounded-lg object-cover" />}<label className="cursor-pointer rounded-xl border border-border px-3 py-2 text-sm hover:bg-surface-2">Upload image<input type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" onChange={async (e) => { const u = e.target.files?.[0] && (await upload(e.target.files[0])); if (u) setF({ ...f, imageUrl: u }); }} /></label></div><div className="flex justify-end"><Button loading={save.isPending}>Save</Button></div></form>}</Modal></div>);
}

function Reviews() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['cms-reviews'], queryFn: () => api('/api/cms/reviews') });
  const set = useMutation({ mutationFn: ({ id, isPublished }: any) => api(`/api/cms/reviews/${id}`, { method: 'PATCH', body: { isPublished } }), onSuccess: () => { qc.invalidateQueries({ queryKey: ['cms-reviews'] }); qc.invalidateQueries({ queryKey: ['home'] }); } });
  return <QueryBoundary q={q} empty={(d) => d.length === 0}>{(d) => <Card className="divide-y divide-border">{d.map((r: any) => <div key={r.id} className="flex items-start justify-between gap-3 p-3 text-sm"><div><p><b>{r.authorName}</b> <span className="text-accent">{'★'.repeat(r.rating)}</span> <span className="text-xs text-muted">{dateTime(r.createdAt)}{r.product && ` · ${r.product.name}`}</span></p><p className="text-muted">{r.comment}</p></div><Button size="sm" variant={r.isPublished ? 'outline' : 'primary'} onClick={() => set.mutate({ id: r.id, isPublished: !r.isPublished })}>{r.isPublished ? 'Unpublish' : 'Publish'}</Button></div>)}</Card>}</QueryBoundary>;
}
