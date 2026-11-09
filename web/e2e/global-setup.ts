import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Fresh isolated database + demo data for every e2e run (the API server is started afterwards by Playwright's webServer).
export default function globalSetup() {
  const cwd = path.resolve(__dirname, '../../server');
  const env = { ...process.env, DATABASE_URL: 'postgresql://postgres:postgres@localhost:5433/minerva_test?schema=public', JWT_ACCESS_SECRET: 'e2e-access-secret-0123456789-abcdefghijklm', JWT_REFRESH_SECRET: 'e2e-refresh-secret-0123456789-abcdefghijkl' };
  execSync('node node_modules/prisma/build/index.js db push --force-reset --skip-generate --accept-data-loss', { cwd, env, stdio: 'pipe' });
  execSync('node node_modules/tsx/dist/cli.mjs prisma/seed.ts --demo', { cwd, env, stdio: 'pipe' });
}
