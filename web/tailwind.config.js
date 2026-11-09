/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ['class', '[data-theme="dark"]'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: 'hsl(var(--bg))', surface: 'hsl(var(--surface))', 'surface-2': 'hsl(var(--surface-2))', fg: 'hsl(var(--fg))', muted: 'hsl(var(--muted))',
        border: 'hsl(var(--border))', brand: 'hsl(var(--brand))', 'brand-fg': 'hsl(var(--brand-fg))', accent: 'hsl(var(--accent))', 'accent-fg': 'hsl(var(--accent-fg))',
        danger: 'hsl(var(--danger))', success: 'hsl(var(--success))', warn: 'hsl(var(--warn))',
      },
      fontFamily: { display: ['Fraunces', 'Georgia', 'serif'], sans: ['Inter', 'system-ui', 'sans-serif'] },
      boxShadow: { card: '0 1px 2px hsl(var(--shadow) / .06), 0 8px 24px -12px hsl(var(--shadow) / .18)' },
      borderRadius: { xl: '14px', '2xl': '20px' },
    },
  },
  plugins: [],
};
