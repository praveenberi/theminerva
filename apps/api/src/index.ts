import { createApp } from './app';
import { assertProductionConfig, env, prisma } from './lib/core';
import { billingTick, birthdays } from './lib/jobs';

assertProductionConfig(); // refuse to start on a public server with development settings
const server = createApp().listen(env.port, () => console.log(JSON.stringify({ event: 'api.listening', port: env.port })));

// Daily birthday vouchers. Idempotent (one per customer per year), so running hourly and after restarts is safe.
const runBirthdays = () => birthdays().catch((e) => console.error('birthday run failed', e));
void runBirthdays();
const birthdayTimer = setInterval(() => void runBirthdays(), 60 * 60_000);

// Renewals, trial endings and grace-period expiry. Idempotent, so hourly runs, restarts and several instances are safe.
const runBillingTick = () => billingTick().catch((e) => console.error('billing run failed', e));
void runBillingTick();
const billingTimer = setInterval(runBillingTick, 60 * 60_000);

/**
 * Container platforms stop a service with SIGTERM and kill it after a grace period. Stop taking new connections,
 * let requests in flight finish (so a deploy does not drop a customer's order halfway), then close the database.
 */
let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(JSON.stringify({ event: 'api.stopping', signal }));
  clearInterval(birthdayTimer);
  clearInterval(billingTimer);
  const force = setTimeout(() => { console.error(JSON.stringify({ event: 'api.forced_exit' })); process.exit(1); }, 25_000);
  force.unref();
  server.close(async () => {
    await prisma.$disconnect().catch(() => {});
    process.exit(0);
  });
  server.closeIdleConnections?.(); // keep-alive sockets with nothing in flight would otherwise hold the server open
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (e) => console.error(JSON.stringify({ event: 'unhandled_rejection', error: String(e) })));
