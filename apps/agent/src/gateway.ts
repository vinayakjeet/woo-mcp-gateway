import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { ToolClient } from './loop.js';

const CONNECT_TIMEOUT_MS = 10_000;
export const TOOL_CALL_TIMEOUT_MS = 60_000;

export type GatewaySession = ToolClient & { close(): Promise<void> };

// One client per turn: the agent JWT belongs to one turn and the agent keeps no state between turns.
export async function connectGateway(url: string, token: string): Promise<GatewaySession> {
  const client = new Client({ name: 'woo-agent', version: '0.1.0' });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { Authorization: `Bearer ${token}` }, redirect: 'error' },
      }),
      { timeout: CONNECT_TIMEOUT_MS },
    );
  } catch (err) {
    await client.close().catch(() => {});
    throw err;
  }
  return {
    // Without a cursor the v2 client walks every page itself.
    listTools: async (signal) =>
      (await client.listTools(undefined, { signal, timeout: CONNECT_TIMEOUT_MS })).tools,
    callTool: (name, args, signal) =>
      client.callTool({ name, arguments: args }, { signal, timeout: TOOL_CALL_TIMEOUT_MS }),
    close: () => client.close(),
  };
}
