import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const KEY_RE = /^urk_([a-z0-9]{8})_([A-Za-z0-9_-]{43})$/;

function randomPrefix(): string {
  let out = '';
  while (out.length < 8) {
    for (const b of randomBytes(16)) {
      // 252 is the largest multiple of 36 below 256, so every character is equally likely.
      if (b < 252 && out.length < 8) out += ALPHABET[b % 36];
    }
  }
  return out;
}

export function hashApiKeySecret(secret: string, pepper: string): string {
  return createHmac('sha256', pepper).update(secret).digest('hex');
}

export function generateApiKey(pepper: string): {
  key: string;
  prefix: string;
  secretHash: string;
} {
  const prefix = randomPrefix();
  const secret = randomBytes(32).toString('base64url');
  return { key: `urk_${prefix}_${secret}`, prefix, secretHash: hashApiKeySecret(secret, pepper) };
}

export function parseApiKey(key: string): { prefix: string; secret: string } | null {
  const m = KEY_RE.exec(key);
  return m ? { prefix: m[1]!, secret: m[2]! } : null;
}

export function verifyApiKeySecret(secret: string, pepper: string, storedHex: string): boolean {
  const a = Buffer.from(hashApiKeySecret(secret, pepper), 'hex');
  const b = Buffer.from(storedHex, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
