import { AnimatePresence, motion } from 'motion/react';
import { AlertTriangle, CheckCircle2, Info, Loader2, X } from 'lucide-react';
import {
  Component, createContext, forwardRef, useCallback, useContext, useEffect, useId, useRef, useState,
  type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes,
} from 'react';
import { cn } from '@/lib/format';

// ───────── Button ─────────
const variants = {
  primary: 'bg-brand text-brand-fg hover:opacity-90',
  accent: 'bg-accent text-accent-fg hover:opacity-90',
  outline: 'border border-border bg-surface hover:bg-surface-2',
  ghost: 'hover:bg-surface-2',
  danger: 'bg-danger text-white hover:opacity-90',
} as const;
const sizes = { sm: 'h-8 px-3 text-sm', md: 'h-10 px-4 text-sm', lg: 'h-12 px-6 text-base', icon: 'h-10 w-10' } as const;

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: keyof typeof variants; size?: keyof typeof sizes; loading?: boolean }>(
  ({ className, variant = 'primary', size = 'md', loading, disabled, children, ...p }, ref) => (
    <button
      ref={ref} disabled={disabled || loading}
      className={cn('inline-flex items-center justify-center gap-2 rounded-xl font-medium transition-[opacity,background,transform] active:scale-[.98] disabled:pointer-events-none disabled:opacity-50', variants[variant], sizes[size], className)}
      {...p}
    >
      {loading && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
      {children}
    </button>
  ),
);
Button.displayName = 'Button';

// ───────── form controls ─────────
const control = 'w-full rounded-xl border border-border bg-surface px-3 text-sm placeholder:text-muted/70 focus-visible:border-accent disabled:opacity-60';
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(({ className, ...p }, ref) => <input ref={ref} className={cn(control, 'h-10', className)} {...p} />);
Input.displayName = 'Input';
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, ...p }, ref) => <textarea ref={ref} className={cn(control, 'min-h-[84px] py-2', className)} {...p} />);
Textarea.displayName = 'Textarea';
export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(({ className, ...p }, ref) => <select ref={ref} className={cn(control, 'h-10 pr-8', className)} {...p} />);
Select.displayName = 'Select';

export function Field({ label, error, hint, children, className }: { label: string; error?: string; hint?: string; children: (id: string, describedBy?: string) => ReactNode; className?: string }) {
  const id = useId();
  const msgId = `${id}-msg`;
  return (
    <div className={cn('space-y-1.5', className)}>
      <label htmlFor={id} className="text-sm font-medium">{label}</label>
      {children(id, error || hint ? msgId : undefined)}
      {error ? <p id={msgId} role="alert" className="text-sm text-danger">{error}</p> : hint ? <p id={msgId} className="text-xs text-muted">{hint}</p> : null}
    </div>
  );
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)}
      className={cn('relative h-6 w-11 shrink-0 rounded-full transition-colors', checked ? 'bg-success' : 'bg-border')}>
      <span className={cn('absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all', checked ? 'left-[22px]' : 'left-0.5')} />
    </button>
  );
}

// ───────── surfaces ─────────
export const Card = ({ className, children, ...p }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('rounded-2xl border border-border bg-surface shadow-card', className)} {...p}>{children}</div>
);

const tones = { neutral: 'bg-surface-2 text-fg', success: 'bg-success/15 text-success', warn: 'bg-warn/15 text-warn', danger: 'bg-danger/15 text-danger', brand: 'bg-brand/15 text-brand' } as const;
export const Badge = ({ tone = 'neutral', children, className }: { tone?: keyof typeof tones; children: ReactNode; className?: string }) => (
  <span className={cn('inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium', tones[tone], className)}>{children}</span>
);

export const Skeleton = ({ className }: { className?: string }) => <div className={cn('skeleton', className)} aria-hidden />;
export const Spinner = () => <Loader2 className="h-5 w-5 animate-spin text-muted" aria-label="Loading" />;

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-border px-6 py-12 text-center">
      <p className="font-display text-lg">{title}</p>
      {children && <p className="max-w-md text-sm text-muted">{children}</p>}
      {action}
    </div>
  );
}
export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-start gap-2 rounded-2xl border border-danger/30 bg-danger/5 p-4 text-sm">
      <p className="flex items-center gap-2 font-medium text-danger"><AlertTriangle className="h-4 w-4" /> {error instanceof Error ? error.message : 'Something went wrong'}</p>
      {retry && <Button size="sm" variant="outline" onClick={retry}>Try again</Button>}
    </div>
  );
}

/** Renders loading / error / empty / data states for a TanStack query. */
export function QueryBoundary<T>({ q, children, empty, skeleton }: {
  q: { isLoading: boolean; error: unknown; data: T | undefined; refetch: () => unknown };
  children: (d: T) => ReactNode; empty?: (d: T) => boolean; skeleton?: ReactNode;
}) {
  if (q.isLoading) return <>{skeleton ?? <div className="space-y-3"><Skeleton className="h-16" /><Skeleton className="h-16" /><Skeleton className="h-16" /></div>}</>;
  if (q.error) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  if (q.data === undefined) return null;
  if (empty?.(q.data)) return <EmptyState title="Nothing here yet" />;
  return <>{children(q.data)}</>;
}

// ───────── modal & drawer ─────────
function useEscape(open: boolean, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === 'Escape' && close();
    document.addEventListener('keydown', h);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', h); document.body.style.overflow = prev; };
  }, [open, close]);
}

export function Modal({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean }) {
  useEscape(open, onClose);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (open) setTimeout(() => ref.current?.focus(), 30); }, [open]);
  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-4">
          <motion.div className="absolute inset-0 bg-black/50" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} />
          <motion.div
            ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title}
            initial={{ opacity: 0, y: 24, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 24 }} transition={{ type: 'spring', damping: 26, stiffness: 320 }}
            className={cn('relative max-h-[92vh] w-full overflow-y-auto rounded-t-2xl bg-surface p-5 shadow-card outline-none sm:rounded-2xl', wide ? 'sm:max-w-3xl' : 'sm:max-w-lg')}
          >
            <div className="mb-4 flex items-start justify-between gap-4">
              <h2 className="font-display text-xl">{title}</h2>
              <button onClick={onClose} aria-label="Close" className="rounded-lg p-1 hover:bg-surface-2"><X className="h-5 w-5" /></button>
            </div>
            {children}
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}

export function Drawer({ open, onClose, title, children, footer }: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode }) {
  useEscape(open, onClose);
  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-50">
          <motion.div className="absolute inset-0 bg-black/50" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} />
          <motion.aside
            role="dialog" aria-modal="true" aria-label={title}
            initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }} transition={{ type: 'spring', damping: 30, stiffness: 320 }}
            className="absolute right-0 top-0 flex h-full w-full max-w-md flex-col bg-surface shadow-card"
          >
            <div className="flex items-center justify-between border-b border-border p-4">
              <h2 className="font-display text-xl">{title}</h2>
              <button onClick={onClose} aria-label="Close" className="rounded-lg p-1 hover:bg-surface-2"><X className="h-5 w-5" /></button>
            </div>
            <div className="flex-1 overflow-y-auto p-4">{children}</div>
            {footer && <div className="border-t border-border p-4">{footer}</div>}
          </motion.aside>
        </div>
      )}
    </AnimatePresence>
  );
}

// ───────── toasts ─────────
type Toast = { id: number; kind: 'success' | 'error' | 'info'; text: string };
const ToastCtx = createContext<(kind: Toast['kind'], text: string) => void>(() => {});
export const useToast = () => useContext(ToastCtx);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((kind: Toast['kind'], text: string) => {
    const id = Date.now() + Math.random();
    setItems((i) => [...i, { id, kind, text }]);
    setTimeout(() => setItems((i) => i.filter((t) => t.id !== id)), kind === 'error' ? 7000 : 4000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[60] flex flex-col items-center gap-2 px-4" aria-live="polite">
        <AnimatePresence>
          {items.map((t) => (
            <motion.div key={t.id} layout initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95 }}
              role={t.kind === 'error' ? 'alert' : 'status'}
              className="pointer-events-auto flex max-w-md items-start gap-2 rounded-xl bg-fg px-4 py-3 text-sm text-bg shadow-card">
              {t.kind === 'success' ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : t.kind === 'error' ? <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> : <Info className="mt-0.5 h-4 w-4 shrink-0" />}
              <span>{t.text}</span>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastCtx.Provider>
  );
}

// ───────── error boundary ─────────
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="mx-auto max-w-lg p-8 text-center">
        <h1 className="font-display text-2xl">Something went wrong</h1>
        <p className="mt-2 text-sm text-muted">The page hit an unexpected error. Reloading usually fixes it.</p>
        <Button className="mt-4" onClick={() => location.reload()}>Reload</Button>
      </div>
    );
  }
}

export function Tabs<T extends string>({ value, onChange, tabs }: { value: T; onChange: (v: T) => void; tabs: Array<{ id: T; label: string }> }) {
  return (
    <div role="tablist" className="flex gap-1 overflow-x-auto rounded-xl bg-surface-2 p-1">
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={value === t.id} onClick={() => onChange(t.id)}
          className={cn('whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-medium transition-colors', value === t.id ? 'bg-surface shadow-sm' : 'text-muted hover:text-fg')}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function ConfirmButton({ onConfirm, children, message, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { onConfirm: () => void; message: string; variant?: keyof typeof variants; size?: keyof typeof sizes }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" onClick={() => setOpen(true)} {...p}>{children}</Button>
      <Modal open={open} onClose={() => setOpen(false)} title="Are you sure?">
        <p className="text-sm text-muted">{message}</p>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button variant="danger" onClick={() => { setOpen(false); onConfirm(); }}>Confirm</Button>
        </div>
      </Modal>
    </>
  );
}
