import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The built app is static files, so the browser gets its security policy from a <meta> tag added at build time only.
// It allows our own scripts, the Google Fonts stylesheet/fonts, https images, blob: images (QR codes) and calls to our own API origin.
// Serve the real response headers too (see README "Deploying the web app") since frame-ancestors cannot be set from a tag.
const csp = {
  name: 'csp-meta',
  apply: 'build' as const,
  transformIndexHtml: (html: string) => html.replace('<head>', `<head>
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob: https:; connect-src 'self'; form-action 'self'; base-uri 'self'; object-src 'none'">
    <meta name="referrer" content="strict-origin-when-cross-origin">`),
};

export default defineConfig({
  plugins: [react(), csp],
  server: { port: 5173, proxy: { '/api': 'http://localhost:4000' } },
});