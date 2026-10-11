import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret, parseKek } from './crypto.js';

const kek = randomBytes(32);

describe('AES-256-GCM records', () => {
  it('round trips and lays out version, key id, nonce, ciphertext, tag', () => {
    const rec = encryptSecret('ghp_secret', kek);
    expect(rec[0]).toBe(1);
    expect(rec[1]).toBe(1);
    expect(rec.length).toBe(2 + 12 + Buffer.byteLength('ghp_secret') + 16);
    expect(decryptSecret(rec, kek)).toBe('ghp_secret');
  });
  it('uses a fresh nonce each time', () => {
    expect(encryptSecret('x', kek).equals(encryptSecret('x', kek))).toBe(false);
  });
  it('rejects a flipped ciphertext byte, a wrong key and a wrong key id', () => {
    const rec = encryptSecret('hello', kek);
    const bad = Buffer.from(rec);
    bad[15] = (bad[15] ?? 0) ^ 1;
    expect(() => decryptSecret(bad, kek)).toThrow();
    expect(() => decryptSecret(rec, randomBytes(32))).toThrow();
    expect(() => decryptSecret(rec, kek, 2)).toThrow(/key id/);
  });
  it('parseKek wants exactly 32 bytes', () => {
    expect(parseKek(kek.toString('base64')).equals(kek)).toBe(true);
    expect(() => parseKek(randomBytes(16).toString('base64'))).toThrow(/32 bytes/);
  });
});
