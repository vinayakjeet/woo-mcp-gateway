import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { connectGateway } from './gateway.js';

describe('connectGateway', () => {
  let server: http.Server | undefined;
  afterEach(() => new Promise((r) => (server ? server.close(r) : r(undefined))));

  it('keeps the query string of the gateway URL on the request', async () => {
    const seen: string[] = [];
    server = http.createServer((req, res) => {
      seen.push(`${req.method} ${req.url}`);
      req.resume();
      res.writeHead(500).end();
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    await connectGateway(`http://127.0.0.1:${port}/mcp?toolMode=search`, 'token').catch(() => {});
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((s) => s.endsWith(' /mcp?toolMode=search'))).toBe(true);
  });
});
