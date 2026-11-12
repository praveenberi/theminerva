import { useRef, useState } from 'react';
import { ArrowDown, ArrowUp, ImagePlus, Monitor, Smartphone, Trash2 } from 'lucide-react';
import { Button, Card } from '@/components/ui';
import { prepareImage } from '@/lib/image';
import { api, errorMessage } from '@/lib/api';
import { cn } from '@/lib/format';

/** One homepage slide. x / y is the focal point (percent) that stays visible when the picture is cropped. */
export interface HeroSlide { url: string; alt?: string; x: number; y: number; fit: 'cover' | 'contain'; hideText?: boolean }

export const DEFAULT_SLIDES: HeroSlide[] = [
  { url: '/hero-1.jpg', alt: 'The Minerva restaurant in Singapore — Indian, Italian and Mexican cuisine, drinks and dining', x: 50, y: 30, fit: 'contain', hideText: true },
  { url: '/hero-2.webp', alt: 'Guests toasting with cocktails at The Minerva restaurant', x: 50, y: 40, fit: 'cover' },
];

export const normalizeSlide = (s: any): HeroSlide => ({
  url: String(s?.url ?? ''), alt: s?.alt ?? '', x: Number.isFinite(+s?.x) ? Math.min(100, Math.max(0, +s.x)) : 50, y: Number.isFinite(+s?.y) ? Math.min(100, Math.max(0, +s.y)) : 35,
  fit: s?.fit === 'contain' ? 'contain' : 'cover', hideText: !!s?.hideText,
});

/** The picture stack used by the homepage and by the admin preview. "contain" shows the whole image over a blurred copy of itself. */
export function HeroBackground({ slides, index, className }: { slides: HeroSlide[]; index: number; className?: string }) {
  return (
    <div className={cn('absolute inset-0 overflow-hidden', className)}>
      {slides.map((s, i) => (
        <div key={s.url + i} className={cn('absolute inset-0 transition-opacity duration-1000', i === index ? 'opacity-100' : 'opacity-0')} aria-hidden={i !== index}>
          {s.fit === 'contain' ? (
            <>
              <img src={s.url} alt="" className="absolute inset-0 h-full w-full scale-110 object-cover opacity-60 blur-2xl" />
              <img src={s.url} alt={s.alt ?? ''} className="absolute inset-0 h-full w-full object-contain" />
            </>
          ) : <img src={s.url} alt={s.alt ?? ''} className="absolute inset-0 h-full w-full object-cover" style={{ objectPosition: `${s.x}% ${s.y}%` }} fetchPriority={i === 0 ? 'high' : 'auto'} />}
        </div>
      ))}
    </div>
  );
}

/** Admin editor: add / remove / reorder slides, choose what part of each photo stays visible, and preview desktop and phone. */
export function HeroSlidesEditor({ value, onChange }: { value: HeroSlide[]; onChange: (v: HeroSlide[]) => void }) {
  const [sel, setSel] = useState(0);
  const [device, setDevice] = useState<'desktop' | 'phone'>('desktop');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const picker = useRef<HTMLDivElement>(null);
  const slides = value;
  const cur = slides[Math.min(sel, slides.length - 1)];
  const idx = Math.min(sel, Math.max(0, slides.length - 1));
  const patch = (p: Partial<HeroSlide>) => onChange(slides.map((s, i) => (i === idx ? { ...s, ...p } : s)));
  const move = (d: number) => { const j = idx + d; if (j < 0 || j >= slides.length) return; const n = [...slides]; [n[idx], n[j]] = [n[j], n[idx]]; onChange(n); setSel(j); };

  const upload = async (f0: File) => {
    setBusy(true); setErr(null);
    try {
      try {
        const f = await prepareImage(f0, 2400);
        const fd = new FormData(); fd.append('file', f);
        const r = await api('/api/uploads', { body: fd });
        onChange([...slides, normalizeSlide({ url: r.url, alt: '', x: 50, y: 35, fit: 'cover' })]); setSel(slides.length);
      } catch (e) { setErr(errorMessage(e)); }
    } finally { setBusy(false); }
  };

  const setFocal = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = picker.current!.getBoundingClientRect();
    patch({ x: Math.round(Math.min(100, Math.max(0, ((e.clientX - r.left) / r.width) * 100))), y: Math.round(Math.min(100, Math.max(0, ((e.clientY - r.top) / r.height) * 100))) });
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {slides.map((s, i) => (
          <button type="button" key={s.url + i} onClick={() => setSel(i)} aria-label={`Edit image ${i + 1}`} aria-pressed={i === idx} className={cn('relative h-16 w-24 overflow-hidden rounded-lg border-2', i === idx ? 'border-brand' : 'border-transparent opacity-80 hover:opacity-100')}>
            <img src={s.url} alt="" className="h-full w-full object-cover" /><span className="absolute left-1 top-1 rounded bg-black/60 px-1 text-[10px] text-white">{i + 1}</span>
          </button>
        ))}
        <label className={cn('inline-flex h-16 w-24 cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed border-border text-xs text-muted hover:bg-surface-2 has-[:focus-visible]:ring-2', busy && 'pointer-events-none opacity-60')}>
          <ImagePlus className="h-5 w-5" />{busy ? 'Uploading…' : 'Add image'}
          <input type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" disabled={busy} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) upload(f); }} />
        </label>
      </div>
      {err && <p role="alert" className="text-sm text-danger">{err}</p>}
      {!slides.length && <p className="text-sm text-muted">No images yet — the website shows its default pictures until you add your own. Several images rotate automatically.</p>}

      {cur && (
        <div className="grid gap-4 md:grid-cols-2">
          <Card className="space-y-3 p-3">
            <p className="text-sm font-medium">Image {idx + 1} of {slides.length}</p>
            <p className="text-xs text-muted">Click or drag on the picture to choose the part that must stay visible when the screen crops it.</p>
            <div ref={picker} className="relative cursor-crosshair touch-none select-none overflow-hidden rounded-lg" onPointerDown={(e) => { (e.target as HTMLElement).setPointerCapture?.(e.pointerId); setFocal(e); }} onPointerMove={(e) => { if (e.buttons) setFocal(e); }}>
              <img src={cur.url} alt="" className="block w-full" draggable={false} />
              <span className="pointer-events-none absolute h-6 w-6 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-brand/40 shadow" style={{ left: `${cur.x}%`, top: `${cur.y}%` }} />
            </div>
            <fieldset className="space-y-1 text-sm">
              <legend className="font-medium">How it fits the screen</legend>
              <label className="flex items-center gap-2"><input type="radio" name="fit" checked={cur.fit === 'cover'} onChange={() => patch({ fit: 'cover' })} /> Fill the screen (edges may be cropped around the chosen point)</label>
              <label className="flex items-center gap-2"><input type="radio" name="fit" checked={cur.fit === 'contain'} onChange={() => patch({ fit: 'contain' })} /> Show the whole picture (nothing cropped)</label>
            </fieldset>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!!cur.hideText} onChange={(e) => patch({ hideText: e.target.checked })} /> Hide the heading and intro text on this image <span className="text-xs text-muted">(use when the picture already has its own title)</span></label>
            <label className="block text-sm"><span className="font-medium">Describe the picture (for screen readers)</span><input className="mt-1 w-full rounded-xl border border-border bg-surface px-3 py-2" value={cur.alt ?? ''} onChange={(e) => patch({ alt: e.target.value })} maxLength={200} /></label>
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" variant="outline" onClick={() => move(-1)} disabled={idx === 0}><ArrowUp className="h-4 w-4" /> Earlier</Button>
              <Button type="button" size="sm" variant="outline" onClick={() => move(1)} disabled={idx === slides.length - 1}><ArrowDown className="h-4 w-4" /> Later</Button>
              <Button type="button" size="sm" variant="ghost" className="text-danger" onClick={() => { onChange(slides.filter((_, i) => i !== idx)); setSel(Math.max(0, idx - 1)); }}><Trash2 className="h-4 w-4" /> Remove</Button>
            </div>
          </Card>

          <Card className="space-y-3 p-3">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium">Preview</p>
              <div className="flex gap-1" role="group" aria-label="Preview size">
                {([['desktop', Monitor, 'Computer'], ['phone', Smartphone, 'Phone']] as const).map(([d, Icon, l]) => <button type="button" key={d} aria-pressed={device === d} onClick={() => setDevice(d)} className={cn('inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs', device === d ? 'border-brand bg-brand text-brand-fg' : 'border-border')}><Icon className="h-3.5 w-3.5" />{l}</button>)}
              </div>
            </div>
            <div className={cn('relative mx-auto overflow-hidden rounded-xl bg-brand text-brand-fg', device === 'desktop' ? 'aspect-[16/9] w-full' : 'aspect-[9/16] w-48')}>
              <HeroBackground slides={[cur]} index={0} />
              <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/25 to-black/10" />
              <div className="absolute inset-x-0 bottom-0 p-3">
                {!cur.hideText && <><p className="text-[8px] font-semibold uppercase tracking-[.3em] text-accent">Welcome to</p><p className={cn('font-display leading-tight', device === 'desktop' ? 'text-2xl' : 'text-lg')}>The Minerva</p></>}
                <span className="mt-1 inline-block rounded-full bg-accent px-2 py-0.5 text-[9px] font-medium text-accent-fg">Order online</span>
              </div>
            </div>
            <p className="text-xs text-muted">The live site shows this picture behind its heading and buttons. The text sits at the bottom, so keep the important part of the photo near the top or middle.</p>
          </Card>
        </div>
      )}
    </div>
  );
}
