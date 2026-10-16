import { pinnedFetch } from '@woo/core';
import { describe, expect, it } from 'vitest';
import { classifyError } from './classify.js';

describe('the pinned fetch from core', () => {
  it('is classified as blocked by the gateway, whatever the target', async () => {
    const f = pinnedFetch({ allowInsecure: true });
    for (const url of ['http://127.0.0.1:9/', 'http://169.254.169.254/latest']) {
      const err = await f(url).catch((e: unknown) => e);
      expect(classifyError(err), url).toEqual({ kind: 'blocked', message: 'address not allowed' });
    }
  });
});
