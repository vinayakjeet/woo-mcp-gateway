import { describe, expect, it } from 'vitest';
import { checkUpstreamUrl, isAllowedAddress } from './ssrf.js';

const PUBLIC = '140.82.112.3';
// Resolution is injected: no test here does a real lookup.
const table: Record<string, string[]> = {
  'api.example.com': [PUBLIC],
  'mixed.example.com': [PUBLIC, '10.0.0.5'],
  'inside.example.com': ['10.1.2.3'],
  'v6.example.com': ['2606:4700:4700::1111'],
  'mapped.example.com': ['::ffff:127.0.0.1'],
  'none.example.com': [],
};
const resolve = async (host: string) => {
  const hit = table[host];
  if (!hit) throw new Error(`ENOTFOUND ${host}`);
  return hit;
};
const check = (url: string, allowInsecure = false) =>
  checkUpstreamUrl(url, { allowInsecure, resolve });

describe('checkUpstreamUrl rejects', () => {
  it.each([
    'http://api.example.com/mcp',
    'ftp://api.example.com',
    'https://127.0.0.1',
    'https://2130706433',
    'https://0177.0.0.1',
    'https://0x7f.0.0.1',
    'https://[::1]',
    'https://[::ffff:127.0.0.1]',
    'https://[::ffff:7f00:1]',
    'https://169.254.169.254',
    'https://169.254.169.254/latest/meta-data',
    'https://metadata.google.internal',
    'https://10.1.2.3',
    'https://172.16.0.1',
    'https://192.168.1.1',
    'https://100.64.0.1',
    'https://[fd00::1]',
    'https://[fe80::1]',
    'https://0.0.0.0',
    'https://[::]',
    'https://fx-mcp.platform.svc',
    'https://fx-mcp.platform.svc.cluster.local:8080/mcp',
    'https://x.cluster.local',
    'https://localhost',
    'https://LOCALHOST.',
    'https://app.localhost',
    'https://fx-mcp',
    'https://user:pw@api.example.com/mcp',
    'https://user@api.example.com/mcp',
    'https://mixed.example.com',
    'https://inside.example.com',
    'https://mapped.example.com',
    'https://none.example.com',
    'https://unknown.example.com',
    'not a url',
    '',
  ])('%s', async (url) => {
    expect(await check(url)).toEqual(expect.any(String));
  });

  it('http even with allowInsecure when the address is private', async () => {
    expect(await check('http://10.0.0.1/mcp', true)).toEqual(expect.any(String));
    expect(await check('http://inside.example.com/mcp', true)).toEqual(expect.any(String));
  });
});

describe('checkUpstreamUrl accepts', () => {
  it('a name that resolves to a public address', async () => {
    expect(await check('https://api.example.com/mcp')).toBeNull();
    expect(await check('https://api.example.com:8443/mcp?x=1')).toBeNull();
  });
  it('a public IPv4 or IPv6 literal', async () => {
    expect(await check(`https://${PUBLIC}/mcp`)).toBeNull();
    expect(await check('https://[2606:4700:4700::1111]/mcp')).toBeNull();
    expect(await check('https://v6.example.com/mcp')).toBeNull();
  });
  it('http for a public name when allowInsecure is set', async () => {
    expect(await check('http://api.example.com/mcp', true)).toBeNull();
  });
});

describe('isAllowedAddress', () => {
  it('allows public unicast addresses only', () => {
    expect(isAllowedAddress(PUBLIC)).toBe(true);
    expect(isAllowedAddress('1.1.1.1')).toBe(true);
    expect(isAllowedAddress('::ffff:8.8.8.8')).toBe(true);
    for (const ip of [
      '127.0.0.1',
      '10.0.0.1',
      '169.254.169.254',
      '224.0.0.1',
      '255.255.255.255',
      '192.0.2.1',
      '::1',
      '::',
      'ff02::1',
      '2002:7f00:1::',
      '2001:0:4136:e378:8000:63bf:3fff:fdd2',
      'not an ip',
    ]) {
      expect(isAllowedAddress(ip), ip).toBe(false);
    }
  });
});
