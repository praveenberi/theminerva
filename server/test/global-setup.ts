import { execSync } from 'node:child_process';
import path from 'node:path';

// Rebuilds the isolated `minerva_test` database from the Prisma schema and loads demo seed data before every run.
export default function setup() {
  const env = { ...process.env, NODE_ENV: 'test', DATABASE_URL: 'postgresql://postgres:postgres@localhost:5433/minerva_test?schema=public' };
  const cwd = path.resolve(__dirname, '..');
  execSync('node node_modules/prisma/build/index.js db push --force-reset --skip-generate --accept-data-loss', { cwd, env, stdio: 'pipe' });
  execSync('node node_modules/tsx/dist/cli.mjs prisma/seed.ts --demo', { cwd, env, stdio: 'pipe' });
}
