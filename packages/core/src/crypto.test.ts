import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret, parseKek } from './crypto.js';

const kek = randomBytes(32);

describe('AES-256-GCM records', () => {
  it('round trips and lays out version, key id, nonce, ciphertext, tag', () => {
    const rec = encryptSecret('ghp_secret', kek, 'main');
    expect(rec[0]).toBe(1);
    expect(rec[1]).toBe(1);
    expect(rec.length).toBe(2 + 12 + Buffer.byteLength('ghp_secret') + 16);
    expect(decryptSecret(rec, kek, 'main')).toBe('ghp_secret');
  });
  it('uses a fresh nonce each time', () => {
    expect(encryptSecret('x', kek, 'main').equals(encryptSecret('x', kek, 'main'))).toBe(false);
  });
  it('rejects a flipped ciphertext byte, a wrong key and a wrong key id', () => {
    const rec = encryptSecret('hello', kek, 'main');
    const bad = Buffer.from(rec);
    bad[15] = (bad[15] ?? 0) ^ 1;
    expect(() => decryptSecret(bad, kek, 'main')).toThrow();
    expect(() => decryptSecret(rec, randomBytes(32), 'main')).toThrow();
    expect(() => decryptSecret(rec, kek, 'main', 2)).toThrow(/key id/);
  });
  it('binds the record to its aad: a wrong slug or an empty aad does not decrypt', () => {
    const rec = encryptSecret('hello', kek, 'main');
    expect(() => decryptSecret(rec, kek, 'fx')).toThrow();
    expect(() => decryptSecret(rec, kek, '')).toThrow();
  });
  it('checks the key length on both directions', () => {
    for (const short of [randomBytes(16), randomBytes(31), randomBytes(33), Buffer.alloc(0)]) {
      expect(() => encryptSecret('x', short, 'main')).toThrow(/32 bytes/);
      expect(() => decryptSecret(encryptSecret('x', kek, 'main'), short, 'main')).toThrow(
        /32 bytes/,
      );
    }
  });
  it('parseKek wants exactly 32 bytes', () => {
    expect(parseKek(kek.toString('base64')).equals(kek)).toBe(true);
    expect(() => parseKek(randomBytes(16).toString('base64'))).toThrow(/32 bytes/);
  });
});
