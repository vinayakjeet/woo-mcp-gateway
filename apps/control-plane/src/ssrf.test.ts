import { describe, expect, it } from 'vitest';
import { parseDenyAddresses } from '@woo/core';
import { urlCheck, urlCheckFromEnv } from './ssrf.js';

const resolve = async () => ['140.82.112.3'];

describe('control-plane URL check', () => {
  it('refuses private, metadata and cluster addresses', async () => {
    const check = urlCheck(false, resolve);
    for (const u of [
      'https://169.254.169.254/',
      'https://10.0.0.1/mcp',
      'http://fx-mcp.platform.svc.cluster.local:8080/mcp',
    ]) {
      expect(await check(u), u).toEqual(expect.any(String));
    }
  });

  it('allows http for a public name only when insecure upstreams are on', async () => {
    expect(await urlCheck(false, resolve)('http://api.example.com/mcp')).toEqual(
      expect.any(String),
    );
    expect(await urlCheck(true, resolve)('http://api.example.com/mcp')).toBeNull();
  });

  it('reads ALLOW_INSECURE_UPSTREAMS and fails closed on anything but "true"', async () => {
    const url = 'http://127.0.0.1/mcp';
    expect(await urlCheckFromEnv({})(url)).toEqual(expect.any(String));
    expect(await urlCheckFromEnv({ ALLOW_INSECURE_UPSTREAMS: 'yes' })(url)).toEqual(
      expect.any(String),
    );
    // Even with insecure on, a loopback address stays refused.
    expect(await urlCheckFromEnv({ ALLOW_INSECURE_UPSTREAMS: 'true' })(url)).toEqual(
      expect.any(String),
    );
  });

  it('reads UPSTREAM_DENY_ADDRESSES: a public address on the list is refused, others pass', async () => {
    const env = { UPSTREAM_DENY_ADDRESSES: '20.193.153.146/32' };
    expect(await urlCheckFromEnv(env)('https://20.193.153.146/mcp')).toEqual(expect.any(String));
    expect(await urlCheckFromEnv({})('https://20.193.153.146/mcp')).toBeNull();
    expect(await urlCheckFromEnv(env)('https://140.82.112.3/mcp')).toBeNull();
    const toVm = async () => ['20.193.153.146'];
    expect(
      await urlCheck(
        false,
        toVm,
        parseDenyAddresses('20.193.153.146'),
      )('https://app.example.com/mcp'),
    ).toEqual(expect.any(String));
  });

  it('fails at startup on a bad UPSTREAM_DENY_ADDRESSES', () => {
    expect(() => urlCheckFromEnv({ UPSTREAM_DENY_ADDRESSES: 'oops' })).toThrow(
      'UPSTREAM_DENY_ADDRESSES',
    );
  });
});
