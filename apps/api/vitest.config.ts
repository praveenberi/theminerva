import { defineConfig } from 'vitest/config';

export default defineConfig({
  // the public order/booking endpoints are rate limited in production; tests place far more than 30 orders a minute
  test: { testTimeout: 30_000, hookTimeout: 60_000, env: { NODE_ENV: 'test', REQUIRE_VERIFIED_EMAIL: '0', AUTH_RATE_LIMIT: '100000', MAIL_RATE_LIMIT: '100000', PUBLIC_WRITE_LIMIT: '100000', API_RATE_LIMIT: '100000', AUTH_CACHE_MS: '0', REFRESH_REUSE_LEEWAY_MS: '0', MAX_FAILED_LOGINS: '8' } },
});
