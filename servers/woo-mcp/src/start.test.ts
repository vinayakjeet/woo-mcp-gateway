import { afterEach, describe, expect, it } from 'vitest';
import { startWooMcp } from './start.js';

const env = {
  PORT: '0',
  MCP_SHARED_TOKEN: 't',
  // Nothing listens here: WooCommerce is down, as it is before the bootstrap Job has run.
  WC_BASE_URL: 'http://127.0.0.1:1',
  WC_SIGNING_BASE_URL: 'http://shop.test',
  WC_CONSUMER_KEY: 'ck',
  WC_CONSUMER_SECRET: 'cs',
};

describe('startWooMcp', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  it('is ready while WooCommerce is unreachable', async () => {
    const s = await startWooMcp(env);
    close = s.close;
    expect((await fetch(`${s.url}/healthz`)).status).toBe(200);
    expect((await fetch(`${s.url}/readyz`)).status).toBe(200);
  });

  it('does not start without its config', async () => {
    await expect(startWooMcp({ ...env, WC_CONSUMER_KEY: '' })).rejects.toThrow(
      'Missing env vars: WC_CONSUMER_KEY',
    );
  });
});
