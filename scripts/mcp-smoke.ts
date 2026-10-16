// Tiny SDK v2 client for humans and e2e.sh. Exit codes: 0 ok, 1 tool or connection error, 2 usage.
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const [url, token, tool, rawArgs] = process.argv.slice(2);
if (!url || !token) {
  console.error('usage: node scripts/mcp-smoke.ts <url> <token> [tool] [json args]');
  process.exit(2);
}
let args: Record<string, unknown> = {};
try {
  args = rawArgs ? (JSON.parse(rawArgs) as Record<string, unknown>) : {};
} catch {
  console.error('json args must be a JSON object');
  process.exit(2);
}

// --listen opens subscriptions/listen, which only a 2026-07-28 connection has. It prints READY once
// the server acknowledged, then one list_changed line per notification, and stops after
// {"seconds": N} (default 10) or when the stream ends.
const listening = tool === '--listen';
const client = new Client(
  { name: 'mcp-smoke', version: '0.1.0' },
  listening ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : undefined,
);
try {
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  if (listening) {
    client.setNotificationHandler('notifications/tools/list_changed', () => {
      console.log('list_changed');
    });
    const sub = await client.listen({ toolsListChanged: true });
    console.log('READY');
    const stop = new Promise<string>((r) =>
      setTimeout(() => r('timeout'), Number(args.seconds ?? 10) * 1000),
    );
    console.log(`ended ${await Promise.race([sub.closed, stop])}`);
    await sub.close();
  } else if (!tool) {
    for (const t of (await client.listTools()).tools) {
      const hint = t.annotations?.readOnlyHint
        ? 'readOnly'
        : t.annotations?.destructiveHint
          ? 'destructive'
          : '-';
      console.log(`${t.name}\t${hint}`);
    }
  } else {
    const r = await client.callTool({ name: tool, arguments: args });
    for (const c of r.content as { type: string; text?: string }[])
      if (c.type === 'text') console.log(c.text);
    if (r.structuredContent) console.log(JSON.stringify(r.structuredContent, null, 2));
    if (r.isError) process.exitCode = 1;
  }
} catch (e) {
  console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
} finally {
  await client.close().catch(() => {});
}
