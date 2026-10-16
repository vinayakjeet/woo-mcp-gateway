import { describe, expect, it } from 'vitest';
import { oauthEnv } from './env.js';

describe('oauthEnv', () => {
  it('is off unless OAUTH_ENABLED is exactly "true"', () => {
    const issuer = 'https://app.example.test';
    expect(oauthEnv({})).toEqual({ enabled: false, issuer: null });
    for (const v of ['TRUE', '1', 'yes', 'false', ' true', '']) {
      expect(oauthEnv({ OAUTH_ENABLED: v, OAUTH_ISSUER: issuer })).toEqual({
        enabled: false,
        issuer: null,
      });
    }
    expect(oauthEnv({ OAUTH_ENABLED: 'true', OAUTH_ISSUER: issuer })).toEqual({
      enabled: true,
      issuer,
    });
  });
  it('requires a clean issuer origin when on, and ignores a bad one when off', () => {
    expect(() => oauthEnv({ OAUTH_ENABLED: 'true' })).toThrow('OAUTH_ISSUER');
    expect(() => oauthEnv({ OAUTH_ENABLED: 'true', OAUTH_ISSUER: 'https://x.test/' })).toThrow(
      'OAUTH_ISSUER',
    );
    expect(oauthEnv({ OAUTH_ISSUER: 'not a url' }).enabled).toBe(false);
  });
});
