// Secrets at rest: service passwords and TOTP secrets are sealed with AES-256-GCM
// using a key that never leaves the data folder (0600). Session tokens are only
// ever stored as SHA-256 hashes.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { PATHS } from '../config.js';

function loadKey() {
  if (fs.existsSync(PATHS.secret)) return Buffer.from(fs.readFileSync(PATHS.secret, 'utf8').trim(), 'base64');
  const key = crypto.randomBytes(32);
  fs.writeFileSync(PATHS.secret, key.toString('base64'), { mode: 0o600 });
  return key;
}
const KEY = loadKey();

export function seal(value, key = KEY) {
  if (value == null || value === '') return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${data.toString('base64url')}`;
}

export function unseal(sealed, key = KEY) {
  if (!sealed) return null;
  const [v, iv, tag, data] = String(sealed).split('.');
  if (v !== 'v1') return null;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** A key derived from a passphrase, for backups that carry secrets. */
export function passphraseKey(passphrase, salt) {
  return crypto.scryptSync(String(passphrase), salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
/** Navidrome-style share IDs: 10 random base62 characters. */
export function shortId(length = 10) {
  const out = [];
  while (out.length < length) {
    for (const b of crypto.randomBytes(length * 2)) {
      if (b < 248 && out.length < length) out.push(B62[b % 62]);
    }
  }
  return out.join('');
}

export const token = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');
export const uuid = () => crypto.randomUUID();

export function safeEqual(a, b) {
  const x = crypto.createHash('sha256').update(String(a ?? '')).digest();
  const y = crypto.createHash('sha256').update(String(b ?? '')).digest();
  return crypto.timingSafeEqual(x, y) && a != null && b != null;
}

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await new Promise((res, rej) =>
    crypto.scrypt(String(password), salt, 64, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (e, k) => (e ? rej(e) : res(k))),
  );
  return `scrypt$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export async function verifyPassword(password, stored) {
  const [kind, salt, hash] = String(stored || '').split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  const got = await new Promise((res, rej) =>
    crypto.scrypt(String(password), Buffer.from(salt, 'base64url'), expected.length, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (e, k) =>
      e ? rej(e) : res(k),
    ),
  );
  return crypto.timingSafeEqual(expected, got);
}

export function md5(v) {
  return crypto.createHash('md5').update(v).digest('hex');
}
