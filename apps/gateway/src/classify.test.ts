import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import { classifyError, isConnectionReset } from './classify.js';
import type { Failure } from './types.js';

const SECRET = 'sk-test-credential-123';
const servers: http.Server[] = [];

async function serve(handler: http.RequestListener): Promise<string> {
  const s = http.createServer(handler);
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}/mcp`;
}

afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
  }
});

async function failureOf(url: string, timeout = 2000): Promise<Failure> {
  const c = new Client({ name: 'classify-test', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${SECRET}` } },
  });
  try {
    await c.connect(transport, { timeout });
    await c.listTools(undefined, { timeout, cacheMode: 'refresh' });
  } catch (err) {
    return classifyError(err);
  } finally {
    await c.close().catch(() => {});
  }
  throw new Error('expected the request to fail');
}

describe('classifyError with real client failures', () => {
  it('classifies a closed port as refused', async () => {
    const url = await serve(() => {});
    const s = servers.pop()!;
    await new Promise((r) => s.close(r));
    expect(await failureOf(url)).toEqual({ kind: 'refused', message: 'connection refused' });
  });

  it.each([
    [401, 'http_401'],
    [403, 'http_403'],
    [404, 'http_404'],
    [503, 'http_5xx'],
  ] as const)('classifies HTTP %i as %s without echoing the credential', async (status, kind) => {
    const url = await serve((req, res) => {
      req.resume();
      res
        .writeHead(status, { 'content-type': 'text/plain' })
        .end(`echo ${req.headers.authorization}`);
    });
    const f = await failureOf(url);
    expect(f.kind).toBe(kind);
    expect(JSON.stringify(f)).not.toContain(SECRET);
  });

  it('classifies a server that never answers as timeout', async () => {
    const url = await serve(() => {});
    expect((await failureOf(url, 200)).kind).toBe('timeout');
  });

  it('classifies an HTML page as protocol', async () => {
    const url = await serve((req, res) => {
      req.resume();
      res.writeHead(200, { 'content-type': 'text/html' }).end('<html></html>');
    });
    expect((await failureOf(url)).kind).toBe('protocol');
  });
});

describe('classifyError with built errors', () => {
  it('classifies an unknown host as dns', () => {
    // Shape undici reports for a failed lookup: TypeError('fetch failed') with the getaddrinfo
    // error as its cause. A real lookup would make this test depend on the resolver.
    const cause = Object.assign(new Error('getaddrinfo ENOTFOUND gateway-test.invalid'), {
      errno: -3008,
      code: 'ENOTFOUND',
      syscall: 'getaddrinfo',
      hostname: 'gateway-test.invalid',
    });
    expect(classifyError(new TypeError('fetch failed', { cause }))).toEqual({
      kind: 'dns',
      message: 'DNS lookup failed',
    });
  });

  it('classifies a certificate failure as tls', () => {
    const cause = Object.assign(new Error('self signed'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' });
    expect(classifyError(new TypeError('fetch failed', { cause }))).toEqual({
      kind: 'tls',
      message: 'TLS handshake failed',
    });
  });

  it('never copies the error message', () => {
    expect(classifyError(new Error(`upstream said Bearer ${SECRET}`))).toEqual({
      kind: 'unknown',
      message: 'unexpected error (unknown)',
    });
  });
});

describe('isConnectionReset', () => {
  const wrapped = (cause: unknown) => new TypeError('fetch failed', { cause });
  const coded = (code: string) => Object.assign(new Error('x'), { code });

  it.each(['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET'])(
    'recognises %s anywhere in the cause chain',
    (code) => {
      expect(isConnectionReset(coded(code))).toBe(true);
      expect(isConnectionReset(wrapped(coded(code)))).toBe(true);
    },
  );

  it('recognises a socket hang up without a code', () => {
    expect(isConnectionReset(wrapped(new Error('socket hang up')))).toBe(true);
  });

  it.each(['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT'])('does not treat %s as a reset', (code) => {
    expect(isConnectionReset(wrapped(coded(code)))).toBe(false);
  });

  it('does not treat other errors as a reset', () => {
    expect(isConnectionReset(new Error('boom'))).toBe(false);
    expect(isConnectionReset('ECONNRESET')).toBe(false);
    expect(isConnectionReset(undefined)).toBe(false);
  });
});
