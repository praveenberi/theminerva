import crypto from 'node:crypto';

/** Time-based one-time passwords (RFC 6238 / RFC 4226) with SHA-1, 30-second steps and 6 digits, the format every authenticator app reads. */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const PERIOD = 30;

export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of s.replace(/=+$/, '').replace(/\s+/g, '').toUpperCase()) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('Invalid base32');
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

/** 160 bits, the size RFC 4226 recommends. */
export const newSecret = () => base32Encode(crypto.randomBytes(20));

export function hotp(secret: Buffer, counter: number, digits = 6): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', secret).update(msg).digest();
  const off = h[h.length - 1] & 0xf;
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

export const stepOf = (ms: number) => Math.floor(ms / 1000 / PERIOD);
export const totpAt = (secretB32: string, ms: number) => hotp(base32Decode(secretB32), stepOf(ms));

/**
 * Checks a code against the current step and one step either side (clock drift). Returns the step that matched, or null.
 * The caller must remember the step and refuse it (and anything older) afterwards, otherwise a code can be replayed.
 */
export function verifyTotp(secretB32: string, code: string, nowMs = Date.now()): number | null {
  const clean = code.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(clean)) return null;
  const secret = base32Decode(secretB32);
  const now = stepOf(nowMs);
  let hit: number | null = null;
  for (const step of [now - 1, now, now + 1]) { // always evaluate all three: same work whatever the answer
    const expected = hotp(secret, step);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(clean))) hit = step;
  }
  return hit;
}

export const otpauthUri = (secretB32: string, account: string, issuer = 'The Minerva') =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${PERIOD}`;
