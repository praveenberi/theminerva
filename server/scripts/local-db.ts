// Starts an embedded PostgreSQL on :5433 (no Docker needed). Data in server/.pgdata
import EmbeddedPostgres from 'embedded-postgres';
import fs from 'node:fs';
const dir = new URL('../.pgdata', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const first = !fs.existsSync(dir + '/PG_VERSION');
const pg = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'postgres', port: 5433, persistent: true });
if (first) await pg.initialise();
await pg.start();
if (first) { await pg.createDatabase('minerva'); await pg.createDatabase('minerva_test'); }
console.log('Postgres ready on :5433 (databases: minerva, minerva_test)');
process.on('SIGINT', async () => { await pg.stop(); process.exit(0); });
setInterval(() => {}, 1 << 30);
