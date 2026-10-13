import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

export type StoreProbe = (url: string, token: string, signal?: AbortSignal) => Promise<void>;

const CALL_TIMEOUT_MS = 10_000;

// One real get_info call through the store's woo-mcp. It reads the store from WooCommerce with the
// store's API keys, so it passes only when the site is installed and the keys work.
export const getInfoProbe: StoreProbe = async (url, token, signal) => {
  const client = new Client({ name: 'control-plane', version: '0.1.0' });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { Authorization: `Bearer ${token}` }, signal },
      }),
    );
    const r = await client.callTool(
      { name: 'get_info', arguments: {} },
      { signal, timeout: CALL_TIMEOUT_MS },
    );
    if (r.isError) {
      const text = (r.content as Array<{ type: string; text?: string }>)
        .map((c) => c.text ?? '')
        .join(' ');
      throw new Error(`get_info answered with an error: ${text}`);
    }
  } finally {
    await client.close().catch(() => {});
  }
};
