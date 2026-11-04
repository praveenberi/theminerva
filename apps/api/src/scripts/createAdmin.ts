import bcrypt from 'bcryptjs';
import { passwordSchema, prisma } from '../lib/core';

/**
 * Creates the first platform admin on a server (or reports that it already exists). Run it once after the first deploy:
 *   ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='a long passphrase' node dist/scripts/createAdmin.js
 * The password is read from the environment so it never appears in the process list or shell history of the server
 * if you pass it through your platform's secret store. MFA is forced on first sign-in in production.
 */
async function main() {
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) throw new Error('Set ADMIN_EMAIL and ADMIN_PASSWORD');
  if (password.length < 14) throw new Error('ADMIN_PASSWORD must be at least 14 characters');
  const ok = passwordSchema.safeParse(password);
  if (!ok.success) throw new Error(ok.error.issues[0].message);
  if (await prisma.user.findUnique({ where: { email } })) {
    console.log(`An account for ${email} already exists. Nothing changed.`);
    return;
  }
  await prisma.user.create({ data: { email, name: 'Platform Admin', role: 'SUPER_ADMIN', passwordHash: await bcrypt.hash(password, 12), emailVerifiedAt: new Date() } });
  console.log(`Platform admin ${email} created. Sign in and set up two-step verification.`);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
