import { McpServer } from '@modelcontextprotocol/server';
import { startMcpHttpServer } from '@woo/core/mcp-http';
import { z } from 'zod';
import { afterEach, describe, expect, it } from 'vitest';
import { getInfoProbe } from './store-probe.js';

describe('getInfoProbe', () => {
  let close = async () => {};
  afterEach(() => close());

  async function start(result: () => { text: string; isError?: boolean }) {
    const calls: string[] = [];
    const s = await startMcpHttpServer({
      port: 0,
      token: 't0ken',
      ready: async () => true,
      createServer: () => {
        const server = new McpServer({ name: 'fake-woo', version: '0.0.0' });
        server.registerTool('get_info', { inputSchema: z.object({}) }, async () => {
          calls.push('get_info');
          const r = result();
          return { content: [{ type: 'text' as const, text: r.text }], isError: r.isError };
        });
        return server;
      },
    });
    close = s.close;
    return { url: `${s.url}/mcp`, calls };
  }

  it('calls get_info once with the bearer token', async () => {
    const { url, calls } = await start(() => ({ text: 'Alpha: 0 orders today' }));
    await getInfoProbe(url, 't0ken');
    expect(calls).toEqual(['get_info']);
  });

  it('rejects a wrong token without calling the tool', async () => {
    const { url, calls } = await start(() => ({ text: 'x' }));
    await expect(getInfoProbe(url, 'wrong')).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it('rejects a tool error and keeps its text', async () => {
    const { url } = await start(() => ({ text: 'woo_unreachable: no route', isError: true }));
    await expect(getInfoProbe(url, 't0ken')).rejects.toThrow('woo_unreachable: no route');
  });

  it('rejects when nothing listens', async () => {
    await expect(getInfoProbe('http://127.0.0.1:1/mcp', 't0ken')).rejects.toThrow();
  });
});
