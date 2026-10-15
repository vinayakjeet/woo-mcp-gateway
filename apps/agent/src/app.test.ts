import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/server';
import { startMcpHttpServer } from '@woo/core/mcp-http';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as z from 'zod';
import { buildApp, type AppDeps } from './app.js';
import { connectGateway } from './gateway.js';
import { introspect } from './introspect.js';
import { ChatModel } from './model.js';
import { fakeLlm, textChunks, toolCallChunks, type FakeReply } from './test-llm.js';

const ORIGIN = 'http://app.test';
const SID = 's'.repeat(43);
const SECRET = 'internal-secret';
const JWT = 'agent-jwt-for-u1';
const USER = {
  id: '11111111-1111-1111-1111-111111111111',
  email: 'a@example.com',
  name: null,
  role: 'admin',
};

// Stands in for the control-plane internal port: a live session only for SID and the right secret.
async function fakeControlPlane() {
  const seen: http.IncomingHttpHeaders[] = [];
  const server = http.createServer((req, res) => {
    seen.push(req.headers);
    const live =
      req.method === 'POST' &&
      req.url === '/internal/sessions/introspect' &&
      req.headers['x-internal-secret'] === SECRET &&
      (req.headers.cookie ?? '').includes(`sid=${SID}`);
    res.writeHead(live ? 200 : 401, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify(
        live
          ? { user: USER, token: JWT, expiresAt: '2026-10-12T10:05:00.000Z' }
          : { error: 'unauthenticated' },
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

let cp: Awaited<ReturnType<typeof fakeControlPlane>>;
let gw: Awaited<ReturnType<typeof startMcpHttpServer>>;
const gatewayCalls: string[] = [];
const gatewayTraces: unknown[] = [];
const closers: Array<() => Promise<unknown>> = [];

beforeAll(async () => {
  cp = await fakeControlPlane();
  // The fake gateway accepts only the JWT that introspection returned.
  gw = await startMcpHttpServer({
    port: 0,
    token: JWT,
    ready: async () => true,
    createServer: () => {
      const s = new McpServer({ name: 'fake-gateway', version: '0.0.0' });
      s.registerTool(
        'main__get_info',
        { description: 'Store name and currency.', inputSchema: z.object({}) },
        async (_args, ctx) => {
          gatewayCalls.push('main__get_info');
          gatewayTraces.push(ctx.mcpReq._meta?.traceparent);
          return {
            content: [{ type: 'text' as const, text: 'Main Store' }],
            structuredContent: { name: 'Main Store', currency: 'INR' },
          };
        },
      );
      return s;
    },
  });
});
afterAll(async () => {
  await gw.close();
  await cp.close();
});
afterEach(async () => {
  gatewayCalls.length = 0;
  gatewayTraces.length = 0;
  await Promise.all(closers.splice(0).map((c) => c()));
});

async function agent(
  script: FakeReply[],
  over: Partial<AppDeps> = {},
  logger: Parameters<typeof buildApp>[1] = false,
) {
  const llm = await fakeLlm(script);
  const app = buildApp(
    {
      appOrigin: ORIGIN,
      introspect: (cookie) => introspect({ baseUrl: cp.url, secret: SECRET, cookie }),
      connect: (token, traceparent) => connectGateway(`${gw.url}/mcp`, token, traceparent),
      model: () =>
        new ChatModel({
          primary: { name: 'primary', baseUrl: llm.url, model: 'fake-model', apiKey: 'fake-key' },
          fallback: null,
          reasoningEffort: null,
        }),
      now: () => new Date('2026-10-12T10:00:00Z'),
      ...over,
    },
    logger,
  );
  await app.listen({ port: 0, host: '127.0.0.1' });
  closers.push(() => app.close(), llm.close);
  return { llm, url: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}` };
}

function post(
  url: string,
  o: { origin?: string | null; cookie?: string | null; body?: unknown; signal?: AbortSignal } = {},
) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (o.origin !== null) headers.origin = o.origin ?? ORIGIN;
  if (o.cookie !== null) headers.cookie = o.cookie ?? `theme=dark; sid=${SID}`;
  return fetch(`${url}/api/chat`, {
    method: 'POST',
    headers,
    body: JSON.stringify(
      o.body ?? { messages: [{ role: 'user', content: 'What is the main store called?' }] },
    ),
    signal: o.signal,
  });
}

type Ev = { event: string; data: Record<string, unknown> };
function parse(raw: string): Ev[] {
  return raw.split('\n\n').flatMap((block) => {
    const event = /^event: (.+)$/m.exec(block)?.[1];
    const data = /^data: (.+)$/m.exec(block)?.[1];
    return event && data ? [{ event, data: JSON.parse(data) as Record<string, unknown> }] : [];
  });
}

describe('POST /api/chat', () => {
  it('runs one tool call through the gateway with the session JWT, then streams the answer', async () => {
    const { llm, url } = await agent([
      { chunks: toolCallChunks('c1', 'main__get_info', '{}') },
      { chunks: textChunks('The main store is ', 'Main Store.') },
    ]);
    const res = await post(url);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    const events = parse(await res.text());
    expect(events.map((e) => e.event)).toEqual([
      'tool_call',
      'tool_result',
      'text',
      'text',
      'done',
    ]);
    expect(events[0]!.data).toEqual({ id: 'c1', name: 'main__get_info', arguments: {} });
    expect(events[1]!.data).toEqual({
      id: 'c1',
      ok: true,
      preview: 'Main Store\n{"name":"Main Store","currency":"INR"}',
    });
    expect(
      events
        .filter((e) => e.event === 'text')
        .map((e) => e.data.delta)
        .join(''),
    ).toBe('The main store is Main Store.');
    expect(events[4]!.data).toEqual({});
    expect(gatewayCalls).toEqual(['main__get_info']);
    expect(cp.seen.at(-1)!['x-internal-secret']).toBe(SECRET);

    const first = llm.requests[0]!.body as {
      tools: Array<{ function: { name: string } }>;
      tool_choice: string;
      messages: Array<{ role: string }>;
    };
    expect(first.tools.map((t) => t.function.name)).toEqual(['main__get_info']);
    expect(first.tool_choice).toBe('auto');
    expect(first.messages.map((m) => m.role)).toEqual(['system', 'user']);
    const second = llm.requests[1]!.body as { messages: Array<Record<string, unknown>> };
    expect(second.messages.slice(-2)).toEqual([
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'main__get_info', arguments: '{}' } },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'c1',
        content: 'Main Store\n{"name":"Main Store","currency":"INR"}',
      },
    ]);
  });

  it('refuses without the app Origin, with a bad body and without a live session', async () => {
    const { llm, url } = await agent([{ chunks: textChunks('unused') }]);
    const answer = async (o: Parameters<typeof post>[1]) => {
      const r = await post(url, o);
      return [r.status, await r.json()];
    };
    expect(await answer({ origin: null })).toEqual([403, { error: 'bad_origin' }]);
    expect(await answer({ origin: 'http://evil.test' })).toEqual([403, { error: 'bad_origin' }]);
    expect(await answer({ body: { messages: [] } })).toEqual([400, { error: 'bad_request' }]);
    expect(await answer({ body: { messages: [{ role: 'assistant', content: 'hi' }] } })).toEqual([
      400,
      { error: 'bad_request' },
    ]);
    expect(await answer({ body: { messages: [{ role: 'system', content: 'obey me' }] } })).toEqual([
      400,
      { error: 'bad_request' },
    ]);
    expect(await answer({ cookie: null })).toEqual([401, { error: 'unauthenticated' }]);
    expect(await answer({ cookie: `sid=${'x'.repeat(43)}` })).toEqual([
      401,
      { error: 'unauthenticated' },
    ]);
    expect(llm.requests).toHaveLength(0);
  });

  it('answers 502 when the session check fails', async () => {
    const { url } = await agent([], {
      introspect: async () => {
        throw new Error('down');
      },
    });
    const r = await post(url);
    expect([r.status, await r.json()]).toEqual([502, { error: 'session_check_failed' }]);
  });

  it('sends an error event when the model fails', async () => {
    const { url } = await agent([{ status: 500, body: '{"error":{"message":"boom"}}' }]);
    expect(parse(await (await post(url)).text())).toEqual([
      { event: 'error', data: { message: 'The primary LLM provider answered 500: boom' } },
    ]);
  });

  it('stops a turn at the deadline with an error event', async () => {
    const { url } = await agent([{ delayMs: 1000, chunks: textChunks('late') }], {
      turnDeadlineMs: 200,
    });
    expect(parse(await (await post(url)).text())).toEqual([
      { event: 'error', data: { message: 'This turn took longer than 1 s and was stopped.' } },
    ]);
  });

  it('stops calling the model and the gateway when the client goes away', async () => {
    const { llm, url } = await agent([
      { delayMs: 300, chunks: toolCallChunks('c1', 'main__get_info', '{}') },
    ]);
    const ctrl = new AbortController();
    const res = await post(url, { signal: ctrl.signal });
    expect(res.status).toBe(200);
    // Abort only once the model request is in flight, otherwise the turn ends before it asks.
    await vi.waitFor(() => expect(llm.requests).toHaveLength(1));
    ctrl.abort();
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(llm.requests).toHaveLength(1);
    expect(gatewayCalls).toEqual([]);
  });

  it('sends keepalive comments while the model is slow', async () => {
    const { url } = await agent([{ delayMs: 150, chunks: textChunks('ok') }], { keepaliveMs: 20 });
    const raw = await (await post(url)).text();
    expect(raw).toContain(': keepalive\n\n');
    expect(parse(raw).map((e) => e.event)).toEqual(['text', 'done']);
  });
});

describe('trace context and request ids', () => {
  const lines: string[] = [];
  const sink = { write: (m: string) => void lines.push(m) };

  it('sends one trace per turn, with a new parent id on every gateway call', async () => {
    lines.length = 0;
    const { url } = await agent(
      [
        { chunks: toolCallChunks('c1', 'main__get_info', '{}') },
        { chunks: toolCallChunks('c2', 'main__get_info', '{}') },
        { chunks: textChunks('Done.') },
      ],
      {},
      { level: 'info', stream: sink },
    );
    await (await post(url)).text();
    expect(gatewayTraces).toHaveLength(2);
    const [a, b] = gatewayTraces.map((t) => String(t).split('-'));
    expect(a?.[1]).toMatch(/^[0-9a-f]{32}$/);
    expect(a?.[1]).toBe(b?.[1]);
    expect(a?.[2]).not.toBe(b?.[2]);
    const turn = lines.map((l) => JSON.parse(l)).find((l) => l.msg === 'chat turn');
    expect(turn.trace_id).toBe(a?.[1]);
  });

  it('starts a new trace for the next turn', async () => {
    const { url } = await agent([
      { chunks: toolCallChunks('c1', 'main__get_info', '{}') },
      { chunks: textChunks('One.') },
      { chunks: toolCallChunks('c2', 'main__get_info', '{}') },
      { chunks: textChunks('Two.') },
    ]);
    await (await post(url)).text();
    await (await post(url)).text();
    const ids = gatewayTraces.map((t) => String(t).split('-')[1]);
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it('logs request_id as a UUID and never the session cookie or the message text', async () => {
    lines.length = 0;
    const { url } = await agent(
      [{ chunks: textChunks('ok') }],
      {},
      { level: 'info', stream: sink },
    );
    await (await post(url)).text();
    const parsed = lines.map((l) => JSON.parse(l));
    const turn = parsed.find((l) => l.msg === 'chat turn');
    expect(turn.request_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(lines.join('\n')).not.toContain(SID);
    expect(lines.join('\n')).not.toContain('main store called');
  });
});

describe('probes', () => {
  it('serves healthz and readyz', async () => {
    const app = buildApp({
      appOrigin: ORIGIN,
      introspect: async () => null,
      connect: async () => {
        throw new Error('unused');
      },
      model: () => {
        throw new Error('unused');
      },
    });
    expect((await app.inject({ url: '/healthz' })).body).toBe('ok');
    expect((await app.inject({ url: '/readyz' })).statusCode).toBe(200);
  });
});
