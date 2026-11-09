import http from 'node:http';
import { createApp } from './app.js';
import { config } from './config.js';
import { prisma } from './db.js';
import { attachWebSocket } from './lib/events.js';
import { logger } from './lib/logger.js';
import { staffAlert } from './services/notify.js';
import { checkLowStock } from './services/inventory.js';

const app = createApp();
const server = http.createServer(app);
attachWebSocket(server);

// Background jobs (in-process; swap for BullMQ workers when REDIS_URL is set — see docs/DEPLOY.md)
const timers: NodeJS.Timeout[] = [];
timers.push(setInterval(async () => {
  try {
    // delayed-order alert: accepted/preparing longer than the order's own prep estimate + 5 min
    const late = await prisma.$queryRaw<Array<{ id: string; number: number }>>`
      SELECT id, number FROM "Order" WHERE status IN ('ACCEPTED','PREPARING') AND "updatedAt" < now() - ("prepMinutes" + 5) * interval '1 minute'
      AND NOT EXISTS (SELECT 1 FROM "StaffNotification" n WHERE n.type='delayed' AND n.message LIKE '%#' || "Order".number || ' %')`;
    for (const o of late) await staffAlert('delayed', `Order #${o.number} is running late`);
    await checkLowStock();
  } catch (e) { logger.error({ err: e }, 'background job failed'); }
}, 60_000));

server.listen(config.PORT, () => logger.info(`The Minerva API listening on :${config.PORT}  (docs: /api/docs)`));

const shutdown = async () => {
  timers.forEach(clearInterval);
  server.close();
  await prisma.$disconnect();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
