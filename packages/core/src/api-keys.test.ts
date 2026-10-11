import { describe, expect, it } from 'vitest';
import { generateApiKey, hashApiKeySecret, parseApiKey, verifyApiKeySecret } from './api-keys.js';

describe('API keys', () => {
  it('generates urk_<8 lowercase alnum>_<43 base64url> and a verifiable hash', () => {
    const { key, prefix, secretHash } = generateApiKey('pepper');
    expect(key).toMatch(/^urk_[a-z0-9]{8}_[A-Za-z0-9_-]{43}$/);
    const parsed = parseApiKey(key);
    expect(parsed?.prefix).toBe(prefix);
    expect(secretHash).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyApiKeySecret(parsed!.secret, 'pepper', secretHash)).toBe(true);
    expect(verifyApiKeySecret(parsed!.secret, 'other', secretHash)).toBe(false);
  });
  it('rejects malformed keys', () => {
    for (const k of [
      '',
      'urk_ABCDEFGH_' + 'a'.repeat(43),
      'urk_abc_x',
      'sk_abcdefgh_' + 'a'.repeat(43),
    ]) {
      expect(parseApiKey(k)).toBeNull();
    }
  });
  it('verify is false for a hash of the wrong length', () => {
    expect(verifyApiKeySecret('s', 'p', 'abcd')).toBe(false);
    expect(hashApiKeySecret('s', 'p')).toHaveLength(64);
  });
});
