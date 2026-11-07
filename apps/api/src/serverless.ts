import { createApp } from './app';
import { assertProductionConfig } from './lib/core';

/**
 * Entry point for Vercel (see /api/index.js and /vercel.json). The Express app is the request handler itself;
 * nothing listens on a port and no timers run, because a serverless function lives only for the request.
 * Scheduled jobs come from Vercel Cron calling /api/cron/run.
 */
assertProductionConfig();
export = createApp();
