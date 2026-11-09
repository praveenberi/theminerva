import { createContext, useContext, useEffect, useMemo, useReducer, type ReactNode } from 'react';

export interface CartLine {
  key: string; productId: string; name: string; slug?: string; imageUrl?: string | null; variantId?: string; variantName?: string;
  addonIds: string[]; addonNames: string[]; unitPrice: number; quantity: number; notes?: string;
}
export type OrderMode = 'DINE_IN' | 'TAKEAWAY' | 'DELIVERY';
interface State { lines: CartLine[]; mode: OrderMode; tableToken?: string; tableLabel?: string; outletId?: string; open: boolean }
type Action =
  | { t: 'add'; line: Omit<CartLine, 'key'> }
  | { t: 'qty'; key: string; quantity: number }
  | { t: 'remove'; key: string }
  | { t: 'clear' }
  | { t: 'mode'; mode: OrderMode }
  | { t: 'table'; token?: string; label?: string }
  | { t: 'outlet'; id?: string }
  | { t: 'open'; open: boolean };

const KEY = 'minerva-cart-v1';
const lineKey = (l: Omit<CartLine, 'key'>) => [l.productId, l.variantId ?? '', [...l.addonIds].sort().join('+'), l.notes ?? ''].join('|');

function reducer(s: State, a: Action): State {
  switch (a.t) {
    case 'add': {
      const key = lineKey(a.line);
      const ex = s.lines.find((l) => l.key === key);
      const lines = ex ? s.lines.map((l) => (l.key === key ? { ...l, quantity: Math.min(50, l.quantity + a.line.quantity) } : l)) : [...s.lines, { ...a.line, key }];
      return { ...s, lines, open: true };
    }
    case 'qty': return { ...s, lines: s.lines.map((l) => (l.key === a.key ? { ...l, quantity: Math.max(1, Math.min(50, a.quantity)) } : l)) };
    case 'remove': return { ...s, lines: s.lines.filter((l) => l.key !== a.key) };
    case 'clear': return { ...s, lines: [] };
    case 'mode': return { ...s, mode: a.mode };
    case 'table': return { ...s, tableToken: a.token, tableLabel: a.label, mode: a.token ? 'DINE_IN' : s.mode };
    case 'outlet': return { ...s, outletId: a.id };
    case 'open': return { ...s, open: a.open };
  }
}

function load(): State {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (raw && Array.isArray(raw.lines)) return { lines: raw.lines, mode: raw.mode ?? 'TAKEAWAY', tableToken: raw.tableToken, tableLabel: raw.tableLabel, outletId: raw.outletId, open: false };
  } catch { /* ignore */ }
  return { lines: [], mode: 'TAKEAWAY', open: false };
}

const Ctx = createContext<{ state: State; dispatch: (a: Action) => void; count: number; subtotal: number }>(null!);
export const useCart = () => useContext(Ctx);

export function CartProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, load);
  useEffect(() => { try { localStorage.setItem(KEY, JSON.stringify({ ...state, open: false })); } catch { /* storage unavailable */ } }, [state]);
  const value = useMemo(() => ({
    state, dispatch,
    count: state.lines.reduce((a, l) => a + l.quantity, 0),
    subtotal: state.lines.reduce((a, l) => a + l.unitPrice * l.quantity, 0), // display only — the server re-prices everything
  }), [state]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
