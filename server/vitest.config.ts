import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    environment: 'node',
    globalSetup: ['test/global-setup.ts'],
    setupFiles: ['test/env.ts'],
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 120000,
    include: ['test/**/*.test.ts'],
  },
});
