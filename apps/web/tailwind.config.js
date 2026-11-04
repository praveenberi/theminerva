export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: { sans: ['Inter', 'system-ui', 'sans-serif'] },
      colors: { brand: { 50: '#fff4ed', 100: '#ffe6d5', 500: '#f26a1b', 600: '#dd5410', 700: '#b83f0f' } },
    },
  },
  plugins: [],
};