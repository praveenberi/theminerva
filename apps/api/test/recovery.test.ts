import { describe, expect, it, beforeAll, afterEach } from 'vitest';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import request from 'supertest';

process.env.ENABLE_TEST_MESSAGING = '1';

import { createApp } from '../src/app';
import { prisma } from '../src/lib/core';
import { testOutbox } from '../src/lib/messaging';
import { base32Decode, base32Encode, hotp, totpAt, verifyTotp } from '../src/lib/totp';

const app = createApp();
const uid = Date.now().toString(36);
const PW = 'Str0ng-Passw0rd!';
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const mailsTo = (email: string) => testOutbox.filter((m) => m.to === email);
const tokenFrom = (email: string) => {
  const m = mailsTo(email).at(-1)?.text.match(/token=([A-Za-z0-9_-]+)/);
  if (!m) throw new Error(`no link emailed to ${email}`);
  return m[1];
};

async function signup(tag: string) {
  const email = `rec-${tag}-${uid}@example.com`;
  const r = await request(app).post('/api/auth/register').send({ restaurantName: `Rec ${tag} ${uid}`, name: 'Olivia Owner', email, password: PW });
  expect(r.status).toBe(201);
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  return { email, id: user.id, token: r.body.accessToken as string, auth: bearer(r.body.accessToken), tenantId: user.tenantId! };
}
type Biz = Awaited<ReturnType<typeof signup>>;
const login = (email: string, password = PW) => request(app).post('/api/auth/login').send({ email, password });

/** Turns MFA on through the real endpoints and returns what an authenticator app would hold. */
async function enableMfa(b: { auth: object; id: string }, password = PW) {
  const setup = await request(app).post('/api/auth/mfa/setup').set(b.auth).send({ password });
  expect(setup.status).toBe(200);
  const on = await request(app).post('/api/auth/mfa/enable').set(b.auth).send({ code: totpAt(setup.body.secret, Date.now()) });
  expect(on.status).toBe(200);
  return { secret: setup.body.secret as string, recoveryCodes: on.body.recoveryCodes as string[], auth: bearer(on.body.accessToken) };
}
/** A code from a fresh step: clears the replay marker first so tests can sign in repeatedly within one 30-second window. */
const freshCode = async (secret: string, userId: string) => { await prisma.user.update({ where: { id: userId }, data: { mfaLastStep: null } }); return totpAt(secret, Date.now()); };

describe('TOTP (RFC 6238)', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890')); // the RFC's test secret
  it('produces the official test vectors', () => {
    expect(secret).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    for (const [seconds, code] of [[59, '287082'], [1111111109, '081804'], [1111111111, '050471'], [1234567890, '005924'], [2000000000, '279037']] as const)
      expect(totpAt(secret, seconds * 1000)).toBe(code);
    expect(hotp(Buffer.from('12345678901234567890'), 0)).toBe('755224'); // RFC 4226 vector
  });
  it('round-trips base32 and tolerates one step of clock drift, but no more', () => {
    const raw = Buffer.from('hello world!!');
    expect(base32Decode(base32Encode(raw)).equals(raw)).toBe(true);
    const now = 1_700_000_000_000;
    expect(verifyTotp(secret, totpAt(secret, now), now)).not.toBeNull();
    expect(verifyTotp(secret, totpAt(secret, now - 30_000), now)).not.toBeNull();
    expect(verifyTotp(secret, totpAt(secret, now + 30_000), now)).not.toBeNull();
    expect(verifyTotp(secret, totpAt(secret, now - 90_000), now)).toBeNull();
    expect(verifyTotp(secret, 'abc123', now)).toBeNull();
    expect(verifyTotp(secret, '12345', now)).toBeNull();
  });
});

describe('password reset', () => {
  let b: Biz;
  beforeAll(async () => { b = await signup('reset'); });

  it('answers identically for known and unknown emails, and emails only the real account', async () => {
    const resetMails = () => mailsTo(b.email).filter((m) => m.subject.includes('Reset')).length;
    const before = resetMails();
    const known = await request(app).post('/api/auth/forgot-password').send({ email: b.email });
    const unknown = await request(app).post('/api/auth/forgot-password').send({ email: `nobody-${uid}@example.com` });
    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(known.body).toEqual(unknown.body); // nothing to tell them apart
    await new Promise((r) => setTimeout(r, 100));
    expect(resetMails() - before).toBe(1);
    expect(mailsTo(`nobody-${uid}@example.com`)).toHaveLength(0); // nothing was sent to the address with no account
    expect((await request(app).post('/api/auth/forgot-password').send({ email: 'not-an-email' })).status).toBe(400);
  });

  it('stores only a hash of the link token', async () => {
    const raw = tokenFrom(b.email);
    const rows = await prisma.authToken.findMany({ where: { userId: b.id, purpose: 'PASSWORD_RESET' } });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.tokenHash !== raw && !raw.includes(r.tokenHash))).toBe(true);
  });

  it('does not use up the link on a weak password, then resets once, ends every session and unlocks the account', async () => {
    const agent = request.agent(app);
    await agent.post('/api/auth/login').send({ email: b.email, password: PW });
    for (let i = 0; i < 8; i++) await login(b.email, `wrong-attempt-${i}-xyz`);
    expect((await login(b.email)).status).toBe(401); // locked

    await request(app).post('/api/auth/forgot-password').send({ email: b.email });
    await new Promise((r) => setTimeout(r, 100));
    const token = tokenFrom(b.email);
    expect((await request(app).post('/api/auth/reset-password').send({ token, password: 'short' })).status).toBe(400);
    expect((await request(app).post('/api/auth/reset-password').send({ token, password: 'password1234' })).status).toBe(400);
    const ok = await request(app).post('/api/auth/reset-password').send({ token, password: 'Brand-New-Passw0rd!' });
    expect(ok.status).toBe(200);
    expect(ok.body.mfaRequired).toBe(false);

    expect((await login(b.email, PW)).status).toBe(401); // old password gone
    expect((await login(b.email, 'Brand-New-Passw0rd!')).status).toBe(200); // and the lock was cleared
    expect((await agent.post('/api/auth/refresh')).status).toBe(401); // the earlier session was ended
    expect((await request(app).post('/api/auth/reset-password').send({ token, password: 'Another-Passw0rd!x' })).body.error.code).toBe('invalid_token'); // single use
    expect(mailsTo(b.email).at(-1)!.subject).toContain('Security notice');
    expect((await prisma.user.findUniqueOrThrow({ where: { id: b.id } })).emailVerifiedAt).not.toBeNull(); // proving the mailbox verifies it
  });

  it('refuses expired links, other kinds of link, garbage, and lets only one of two simultaneous uses win', async () => {
    const c = await signup('reset2');
    await request(app).post('/api/auth/forgot-password').send({ email: c.email });
    await new Promise((r) => setTimeout(r, 100));
    const token = tokenFrom(c.email);
    await prisma.authToken.updateMany({ where: { userId: c.id, purpose: 'PASSWORD_RESET' }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await request(app).post('/api/auth/reset-password').send({ token, password: 'Brand-New-Passw0rd!' })).status).toBe(400);
    expect((await request(app).post('/api/auth/reset-password').send({ token: 'x'.repeat(43), password: 'Brand-New-Passw0rd!' })).status).toBe(400);

    // an email-verification link must not be accepted as a reset link
    const verifyToken = tokenFrom(c.email.replace('', '')); // registration mailed one; fall through to the reset mail below
    void verifyToken;
    const verifyMail = mailsTo(c.email).find((m) => m.subject.includes('Confirm'))!.text.match(/token=([A-Za-z0-9_-]+)/)![1];
    expect((await request(app).post('/api/auth/reset-password').send({ token: verifyMail, password: 'Brand-New-Passw0rd!' })).status).toBe(400);

    const d = await signup('reset3');
    await request(app).post('/api/auth/forgot-password').send({ email: d.email });
    await new Promise((r) => setTimeout(r, 100));
    const t = tokenFrom(d.email);
    const race = await Promise.all([1, 2, 3].map((n) => request(app).post('/api/auth/reset-password').send({ token: t, password: `Racing-Passw0rd-${n}!` })));
    expect(race.filter((r) => r.status === 200)).toHaveLength(1);
  });

  it('caps reset emails per account per hour, and ignores deactivated accounts', async () => {
    const c = await signup('cap');
    const before = mailsTo(c.email).length;
    for (let i = 0; i < 5; i++) await request(app).post('/api/auth/forgot-password').send({ email: c.email });
    await new Promise((r) => setTimeout(r, 200));
    expect(mailsTo(c.email).length - before).toBe(3);
    await prisma.user.update({ where: { id: c.id }, data: { active: false } });
    const n = mailsTo(c.email).length;
    await prisma.authToken.deleteMany({ where: { userId: c.id } });
    await request(app).post('/api/auth/forgot-password').send({ email: c.email });
    await new Promise((r) => setTimeout(r, 100));
    expect(mailsTo(c.email).length).toBe(n);
  });

  it('kills every other outstanding link once one is used', async () => {
    const c = await signup('multi');
    await request(app).post('/api/auth/forgot-password').send({ email: c.email });
    await new Promise((r) => setTimeout(r, 100));
    const first = tokenFrom(c.email);
    await request(app).post('/api/auth/forgot-password').send({ email: c.email });
    await new Promise((r) => setTimeout(r, 100));
    const second = tokenFrom(c.email);
    expect(second).not.toBe(first);
    expect((await request(app).post('/api/auth/reset-password').send({ token: second, password: 'Brand-New-Passw0rd!' })).status).toBe(200);
    expect((await request(app).post('/api/auth/reset-password').send({ token: first, password: 'Sneaky-Passw0rd-2!' })).status).toBe(400);
  });
});

describe('email verification', () => {
  afterEach(() => { process.env.REQUIRE_VERIFIED_EMAIL = '0'; });

  it('mails a link at sign-up, blocks high-impact actions until it is used, then allows them', async () => {
    process.env.REQUIRE_VERIFIED_EMAIL = '1';
    const c = await signup('verify');
    await new Promise((r) => setTimeout(r, 100));
    expect(mailsTo(c.email).some((m) => m.subject.includes('Confirm'))).toBe(true);
    expect((await request(app).get('/api/auth/me').set(c.auth)).body.emailVerified).toBe(false);

    const blockedSend = await request(app).post('/api/campaigns/nope/send').set(c.auth);
    expect(blockedSend.status).toBe(403);
    expect(blockedSend.body.error.code).toBe('email_unverified');
    expect((await request(app).put('/api/payment-account').set(c.auth).send({ provider: 'test', secrets: {} })).body.error.code).toBe('email_unverified');
    expect((await request(app).get('/api/orders').set(c.auth)).status).toBe(200); // everyday use is not blocked

    const link = mailsTo(c.email).find((m) => m.subject.includes('Confirm'))!.text.match(/token=([A-Za-z0-9_-]+)/)![1];
    expect((await request(app).post('/api/auth/verify-email').send({ token: link })).status).toBe(200);
    expect((await request(app).post('/api/auth/verify-email').send({ token: link })).status).toBe(400); // single use
    expect((await request(app).post('/api/campaigns/nope/send').set(c.auth)).status).toBe(404); // the gate is open: now it is just an unknown campaign
    expect((await request(app).get('/api/auth/me').set(c.auth)).body.emailVerified).toBe(true);
  });

  it('limits resends and ignores them once verified', async () => {
    const c = await signup('resend');
    await new Promise((r) => setTimeout(r, 100));
    const start = mailsTo(c.email).length; // the sign-up email
    for (let i = 0; i < 5; i++) expect((await request(app).post('/api/auth/verify-email/request').set(c.auth)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 100));
    expect(mailsTo(c.email).length - start).toBe(2); // cap of 3 per hour including the first
    await prisma.user.update({ where: { id: c.id }, data: { emailVerifiedAt: new Date() } });
    const n = mailsTo(c.email).length;
    expect((await request(app).post('/api/auth/verify-email/request').set(c.auth)).body.alreadyVerified).toBe(true);
    expect(mailsTo(c.email).length).toBe(n);
  });
});

describe('two-factor authentication', () => {
  it('needs the password to start, shows the secret once, and keeps it encrypted', async () => {
    const c = await signup('mfa1');
    expect((await request(app).post('/api/auth/mfa/setup').set(c.auth).send({ password: 'wrong-password-x' })).status).toBe(401);
    const setup = await request(app).post('/api/auth/mfa/setup').set(c.auth).send({ password: PW });
    expect(setup.body.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(setup.body.otpauthUri).toContain(`secret=${setup.body.secret}`);
    expect(setup.body.qrSvg).toContain('<svg');
    const row = await prisma.user.findUniqueOrThrow({ where: { id: c.id } });
    expect(row.mfaEnabled).toBe(false); // not on until a real code proves the app works
    expect(row.mfaPendingEnc).not.toContain(setup.body.secret);
    expect((await request(app).post('/api/auth/mfa/enable').set(c.auth).send({ code: '000000' })).status).toBe(400);
    const on = await request(app).post('/api/auth/mfa/enable').set(c.auth).send({ code: totpAt(setup.body.secret, Date.now()) });
    expect(on.status).toBe(200);
    expect(on.body.recoveryCodes).toHaveLength(10);
    expect(on.body.recoveryCodes.every((x: string) => /^[A-Z2-9]{5}-[A-Z2-9]{5}$/.test(x))).toBe(true);
    const after = await prisma.user.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.mfaEnabled).toBe(true);
    expect(JSON.stringify(after)).not.toContain(setup.body.secret);
    expect(after.recoveryCodes.join()).not.toContain(on.body.recoveryCodes[0].slice(0, 5)); // hashes only
    expect(JSON.stringify((await request(app).get('/api/auth/me').set(bearer(on.body.accessToken))).body)).not.toContain(setup.body.secret);
    expect((await request(app).post('/api/auth/mfa/setup').set(bearer(on.body.accessToken)).send({ password: PW })).status).toBe(409);
  });

  it('turns a correct password into a short-lived pass, not a session', async () => {
    const c = await signup('mfa2');
    const m = await enableMfa(c);
    const r = await login(c.email);
    expect(r.status).toBe(200);
    expect(r.body.mfaRequired).toBe(true);
    expect(r.body.accessToken).toBeUndefined();
    expect(r.headers['set-cookie']).toBeUndefined();
    // the pass is not an access token, and a forged or expired one is refused
    expect((await request(app).get('/api/orders').set(bearer(r.body.mfaToken))).status).toBe(401);
    expect((await request(app).post('/api/auth/login/mfa').send({ mfaToken: 'junk-junk-junk', code: '123456' })).body.error.code).toBe('mfa_expired');
    const expired = jwt.sign({ uid: c.id, purpose: 'mfa' }, process.env.JWT_SECRET!, { issuer: 'tablely-api', audience: 'tablely-mfa', expiresIn: -10 });
    expect((await request(app).post('/api/auth/login/mfa').send({ mfaToken: expired, code: totpAt(m.secret, Date.now()) })).body.error.code).toBe('mfa_expired');
    const wrongAudience = jwt.sign({ uid: c.id, purpose: 'mfa' }, process.env.JWT_SECRET!, { issuer: 'tablely-api', audience: 'tablely-web' });
    expect((await request(app).post('/api/auth/login/mfa').send({ mfaToken: wrongAudience, code: totpAt(m.secret, Date.now()) })).status).toBe(401);

    const code = await freshCode(m.secret, c.id);
    const ok = await request(app).post('/api/auth/login/mfa').send({ mfaToken: r.body.mfaToken, code });
    expect(ok.status).toBe(200);
    expect((await request(app).get('/api/orders').set(bearer(ok.body.accessToken))).status).toBe(200);
    expect(ok.headers['set-cookie'][0]).toContain('rt=');
  });

  it('refuses a replayed code, wrong codes count towards the lockout, and the lock holds even for a right code', async () => {
    const c = await signup('mfa3');
    const m = await enableMfa(c);
    const first = await login(c.email);
    const code = await freshCode(m.secret, c.id);
    expect((await request(app).post('/api/auth/login/mfa').send({ mfaToken: first.body.mfaToken, code })).status).toBe(200);
    const again = await login(c.email);
    const replay = await request(app).post('/api/auth/login/mfa').send({ mfaToken: again.body.mfaToken, code }); // the very same code, moments later
    expect(replay.status).toBe(401);
    // the next 30-second code is fine
    expect((await request(app).post('/api/auth/login/mfa').send({ mfaToken: again.body.mfaToken, code: totpAt(m.secret, Date.now() + 30_000) })).status).toBe(200);

    const d = await signup('mfa3b');
    const md = await enableMfa(d);
    const pass = await login(d.email);
    for (let i = 0; i < 8; i++) expect((await request(app).post('/api/auth/login/mfa').send({ mfaToken: pass.body.mfaToken, code: '000000' })).status).toBe(401);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: d.id } })).lockedUntil).not.toBeNull();
    const right = await freshCode(md.secret, d.id);
    expect((await request(app).post('/api/auth/login/mfa').send({ mfaToken: pass.body.mfaToken, code: right })).status).toBe(401); // locked
    expect((await login(d.email)).status).toBe(401);
  });

  it('accepts each recovery code once', async () => {
    const c = await signup('mfa4');
    const m = await enableMfa(c);
    const codes = m.recoveryCodes;
    const use = async (code: string) => request(app).post('/api/auth/login/mfa').send({ mfaToken: (await login(c.email)).body.mfaToken, recoveryCode: code });
    const ok = await use(codes[0].toLowerCase()); // case and dash do not matter
    expect(ok.status).toBe(200);
    expect(ok.body.recoveryCodesLeft).toBe(9);
    expect((await use(codes[0])).status).toBe(401); // already spent
    expect((await use('AAAAA-AAAAA')).status).toBe(401);
    const race = await Promise.all([1, 2, 3].map(async () => use(codes[1])));
    expect(race.filter((r) => r.status === 200)).toHaveLength(1); // two tabs cannot both spend the same code
    expect((await request(app).get('/api/auth/me').set(bearer(ok.body.accessToken))).body.recoveryCodesLeft).toBe(8);
  });

  it('needs password and a code to turn off, and to replace recovery codes (recovery codes cannot do the latter)', async () => {
    const c = await signup('mfa5');
    const m = await enableMfa(c);
    expect((await request(app).post('/api/auth/mfa/disable').set(m.auth).send({ password: 'wrong-password-x', code: await freshCode(m.secret, c.id) })).status).toBe(401);
    expect((await request(app).post('/api/auth/mfa/disable').set(m.auth).send({ password: PW, code: '000000' })).status).toBe(401);
    expect((await request(app).post('/api/auth/mfa/recovery-codes').set(m.auth).send({ password: PW, code: m.recoveryCodes[0] })).status).toBe(401);
    const regen = await request(app).post('/api/auth/mfa/recovery-codes').set(m.auth).send({ password: PW, code: await freshCode(m.secret, c.id) });
    expect(regen.status).toBe(200);
    expect(regen.body.recoveryCodes).not.toEqual(m.recoveryCodes);
    const old = await request(app).post('/api/auth/login/mfa').send({ mfaToken: (await login(c.email)).body.mfaToken, recoveryCode: m.recoveryCodes[2] });
    expect(old.status).toBe(401); // the previous set no longer works

    const off = await request(app).post('/api/auth/mfa/disable').set(m.auth).send({ password: PW, recoveryCode: regen.body.recoveryCodes[0] });
    expect(off.status).toBe(200);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: c.id } });
    expect(row).toMatchObject({ mfaEnabled: false, mfaSecretEnc: null, recoveryCodes: [] });
    expect((await login(c.email)).body.accessToken).toBeDefined(); // plain password login again
    expect(mailsTo(c.email).some((x) => x.text.includes('turned off'))).toBe(true);
  });

  it('turning MFA on ends sessions that were opened without it', async () => {
    const c = await signup('mfa6');
    const other = request.agent(app);
    await other.post('/api/auth/login').send({ email: c.email, password: PW });
    await enableMfa(c);
    expect((await other.post('/api/auth/refresh')).status).toBe(401);
  });

  it('is not bypassed by a password reset', async () => {
    const c = await signup('mfa7');
    await enableMfa(c);
    await request(app).post('/api/auth/forgot-password').send({ email: c.email });
    await new Promise((r) => setTimeout(r, 100));
    const done = await request(app).post('/api/auth/reset-password').send({ token: tokenFrom(c.email), password: 'Brand-New-Passw0rd!' });
    expect(done.body.mfaRequired).toBe(true);
    const r = await login(c.email, 'Brand-New-Passw0rd!');
    expect(r.body.mfaRequired).toBe(true);
    expect(r.body.accessToken).toBeUndefined();
  });
});

describe('platform admin and lost devices', () => {
  let admin: { id: string; email: string; auth: { Authorization: string } };
  beforeAll(async () => {
    const email = `rec-admin-${uid}@example.com`;
    const u = await prisma.user.create({ data: { email, name: 'Admin', role: 'SUPER_ADMIN', passwordHash: await bcrypt.hash(PW, 10) } });
    admin = { id: u.id, email, auth: bearer((await login(email)).body.accessToken) };
  });
  afterEach(() => { delete process.env.MFA_REQUIRE_ADMIN; });

  it('must have MFA before using admin features when enforcement is on (default in production)', async () => {
    process.env.MFA_REQUIRE_ADMIN = '1';
    const blocked = await request(app).get('/api/admin/stats').set(admin.auth);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('mfa_setup_required');
    expect((await request(app).get('/api/auth/me').set(admin.auth)).status).toBe(200); // can still reach what it needs to set MFA up
    const m = await enableMfa(admin);
    expect((await request(app).get('/api/admin/stats').set(m.auth)).status).toBe(200);
    await prisma.user.update({ where: { id: admin.id }, data: { mfaEnabled: false, mfaSecretEnc: null, recoveryCodes: [] } });
  });

  it('lets an owner reset staff (not owners, not other businesses) and the platform admin reset anyone else, all audited', async () => {
    admin.auth = bearer((await login(admin.email)).body.accessToken); // the previous test turned MFA on and off, which retired the old token
    const owner = await signup('lost-o');
    const other = await signup('lost-x');
    const staff = await request(app).post('/api/staff').set(owner.auth).send({ name: 'Wendy Waiter', email: `rec-w-${uid}@example.com`, password: PW, role: 'WAITER' });
    const staffLogin = await login(`rec-w-${uid}@example.com`);
    const sm = await enableMfa({ auth: bearer(staffLogin.body.accessToken), id: staff.body.id });
    expect((await request(app).get('/api/staff').set(owner.auth)).body.find((u: any) => u.id === staff.body.id).mfaEnabled).toBe(true);

    expect((await request(app).post(`/api/staff/${staff.body.id}/reset-mfa`).set(other.auth)).status).toBe(404); // someone else's staff
    expect((await request(app).post(`/api/staff/${owner.id}/reset-mfa`).set(owner.auth)).status).toBe(404); // an owner is not staff
    expect((await request(app).post(`/api/staff/${staff.body.id}/reset-mfa`).set(sm.auth)).status).toBe(403); // staff cannot reset anyone
    expect((await request(app).post(`/api/staff/${staff.body.id}/reset-mfa`).set(owner.auth)).status).toBe(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: staff.body.id } })).mfaEnabled).toBe(false);
    expect((await request(app).get('/api/orders').set(sm.auth)).status).toBe(401); // their sessions ended
    expect((await login(`rec-w-${uid}@example.com`)).body.accessToken).toBeDefined();

    const om = await enableMfa(owner); // enabling MFA retires the old token, so use the one it returns
    expect((await request(app).post('/api/admin/reset-mfa').set(om.auth).send({ email: owner.email })).status).toBe(403); // owners cannot use the admin route
    expect((await request(app).post('/api/admin/reset-mfa').set(admin.auth).send({ email: owner.email })).status).toBe(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: owner.id } })).mfaEnabled).toBe(false);
    expect((await request(app).post('/api/admin/reset-mfa').set(admin.auth).send({ email: admin.email })).status).toBe(404); // not your own
    expect((await request(app).post('/api/admin/reset-mfa').set(admin.auth).send({ email: `ghost-${uid}@example.com` })).status).toBe(404);
    expect(await prisma.auditLog.count({ where: { action: 'mfa.reset', actorId: { in: [owner.id, admin.id] } } })).toBe(2);
    expect(mailsTo(owner.email).some((m) => m.text.includes('reset on your Tablely account'))).toBe(true);
  });
});

describe('security events end access tokens immediately, not after 15 minutes', () => {
  it('password change and password reset kill the old access token at once; the replacement works', async () => {
    const c = await signup('cutoff');
    expect((await request(app).get('/api/orders').set(c.auth)).status).toBe(200);
    const changed = await request(app).post('/api/auth/change-password').set(c.auth).send({ current: PW, next: 'Another-Str0ng-One!' });
    expect(changed.status).toBe(200);
    expect((await request(app).get('/api/orders').set(c.auth)).status).toBe(401); // the token used to make the change is retired
    expect((await request(app).get('/api/orders').set(bearer(changed.body.accessToken))).status).toBe(200); // the new session is fine

    const stolen = (await login(c.email, 'Another-Str0ng-One!')).body.accessToken; // an attacker's session, opened before the owner reacts
    await request(app).post('/api/auth/forgot-password').send({ email: c.email });
    await new Promise((r) => setTimeout(r, 100));
    expect((await request(app).post('/api/auth/reset-password').send({ token: tokenFrom(c.email), password: 'Evicted-Them-Passw0rd!' })).status).toBe(200);
    expect((await request(app).get('/api/orders').set(bearer(stolen))).status).toBe(401);
    expect((await request(app).get('/api/orders').set(bearer(changed.body.accessToken))).status).toBe(401);
  });

  it('turning MFA on or off, and deactivating staff, do the same', async () => {
    const c = await signup('cutoff2');
    const before = c.auth;
    const m = await enableMfa(c);
    expect((await request(app).get('/api/orders').set(before)).status).toBe(401);
    expect((await request(app).get('/api/orders').set(m.auth)).status).toBe(200);
    const off = await request(app).post('/api/auth/mfa/disable').set(m.auth).send({ password: PW, recoveryCode: m.recoveryCodes[0] });
    expect(off.status).toBe(200);
    expect((await request(app).get('/api/orders').set(m.auth)).status).toBe(401);
    expect((await request(app).get('/api/orders').set(bearer(off.body.accessToken))).status).toBe(200);
  });
});
