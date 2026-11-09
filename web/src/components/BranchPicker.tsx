import { MapPin } from 'lucide-react';
import { useCart } from '@/lib/cart';
import { usePublicOutlets } from '@/lib/outlet';
import { cn } from '@/lib/format';

/** Renders nothing on a single-branch site. Dine-in via table QR picks the branch automatically. */
export function BranchPicker({ required }: { required?: boolean }) {
  const { data } = usePublicOutlets();
  const { state, dispatch } = useCart();
  if (!data || data.length === 0 || state.tableToken) return null;
  return (
    <fieldset className="mb-4">
      <legend className="mb-2 flex items-center gap-1 text-sm font-medium"><MapPin className="h-4 w-4 text-accent" /> Choose a branch{required && <span className="text-danger"> *</span>}</legend>
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Branch">
        {data.map((o: any) => (
          <button type="button" role="radio" aria-checked={state.outletId === o.id} key={o.id} onClick={() => dispatch({ t: 'outlet', id: o.id })}
            className={cn('rounded-xl border px-4 py-2 text-left text-sm', state.outletId === o.id ? 'border-accent bg-accent/10' : 'border-border hover:bg-surface-2')}>
            <span className="block font-medium">{o.name}</span>{o.address && <span className="block text-xs text-muted">{o.address}</span>}
          </button>))}
      </div>
      {!state.outletId && <p className="mt-1 text-xs text-muted">Menu prices and availability can differ by branch.</p>}
    </fieldset>
  );
}
