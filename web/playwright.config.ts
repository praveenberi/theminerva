import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const API_PORT = 4100;
const WEB_PORT = 5174;
const serverDir = path.resolve(__dirname, '../server');
const testEnv = {
  NODE_ENV: 'development', PORT: String(API_PORT),
  DATABASE_URL: 'postgresql://postgres:postgres@localhost:5433/minerva_test?schema=public',
  JWT_ACCESS_SECRET: 'e2e-access-secret-0123456789-abcdefghijklm', JWT_REFRESH_SECRET: 'e2e-refresh-secret-0123456789-abcdefghijkl',
  WEB_ORIGIN: `http://localhost:${WEB_PORT}`, PUBLIC_WEB_URL: `http://localhost:${WEB_PORT}`, LOG_LEVEL: 'silent',
};

// PW_CHANNEL=chrome uses the locally installed Chrome (useful when Playwright's bundled Chromium can't be downloaded/launched)
export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: false, workers: 1, retries: process.env.CI ? 1 : 0, timeout: 60_000,
  reporter: [['list']],
  use: { baseURL: `http://localhost:${WEB_PORT}`, trace: 'retain-on-failure', screenshot: 'only-on-failure', channel: process.env.PW_CHANNEL || undefined },
  projects: [
    { name: 'desktop', testIgnore: /mobile.spec.ts/, use: { ...devices['Desktop Chrome'], channel: process.env.PW_CHANNEL || undefined } },
    { name: 'mobile', testMatch: /mobile\.spec\.ts/, use: { ...devices['Pixel 7'], channel: process.env.PW_CHANNEL || undefined } },
  ],
  webServer: [
    { command: 'node node_modules/tsx/dist/cli.mjs src/index.ts', cwd: serverDir, port: API_PORT, env: testEnv, reuseExistingServer: !process.env.CI, timeout: 60_000 },
    { command: `node node_modules/vite/bin/vite.js --port ${WEB_PORT} --strictPort`, port: WEB_PORT, env: { VITE_API_PROXY: `http://localhost:${API_PORT}` }, reuseExistingServer: !process.env.CI, timeout: 60_000 },
  ],
});
