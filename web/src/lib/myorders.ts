// Orders placed from this browser, so customers can get back to their status after browsing the menu.
const KEY = 'minerva-my-orders-v1';
const CONTACT = 'minerva-table-contact-v1';
const MAX_AGE = 24 * 3600_000;

export interface MyOrder { token: string; number: number; at: number }

export function myOrders(): MyOrder[] {
  try { return (JSON.parse(localStorage.getItem(KEY) || '[]') as MyOrder[]).filter((o) => Date.now() - o.at < MAX_AGE); } catch { return []; }
}
export function rememberOrder(o: { token: string; number: number }) {
  try { localStorage.setItem(KEY, JSON.stringify([{ ...o, at: Date.now() }, ...myOrders().filter((x) => x.token !== o.token)].slice(0, 20))); window.dispatchEvent(new Event('minerva-orders')); } catch { /* storage unavailable */ }
}

/** The guest's own contact details, kept on their device per table so a second order is pre-filled. */
export function rememberContact(tableToken: string, c: { name?: string; phone?: string; email?: string }) {
  try { localStorage.setItem(CONTACT, JSON.stringify({ tableToken, ...c, at: Date.now() })); } catch { /* ignore */ }
}
/** Forget the saved name / phone / email — called once every order from this device is finished. */
export function clearContact() {
  try { if (localStorage.getItem(CONTACT)) localStorage.removeItem(CONTACT); } catch { /* ignore */ }
}
export function recallContact(tableToken: string, sessionOpenedAt?: string | null): { name?: string; phone?: string; email?: string } | null {
  try {
    const c = JSON.parse(localStorage.getItem(CONTACT) || 'null');
    // only valid for the table visit that is still open (a new party at the same table must not inherit it)
    if (!c || c.tableToken !== tableToken || !sessionOpenedAt || c.at < new Date(sessionOpenedAt).getTime() - 5000) return null;
    return c;
  } catch { return null; }
}
