export function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('minerva-theme', next); } catch { /* storage unavailable */ }
  return next;
}
