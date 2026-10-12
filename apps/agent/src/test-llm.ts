import http from 'node:http';
import type { AddressInfo } from 'node:net';

export type FakeReply = {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  chunks?: unknown[];
  delayMs?: number;
};
export type SeenRequest = {
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown>;
};

// An OpenAI-compatible endpoint that plays a script. The last reply repeats once the script runs out.
export async function fakeLlm(script: FakeReply[]) {
  const requests: SeenRequest[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => (raw += c));
    req.on('end', () => {
      requests.push({
        url: req.url ?? '',
        headers: req.headers,
        body: JSON.parse(raw || '{}') as Record<string, unknown>,
      });
      const r = script[Math.min(requests.length, script.length) - 1] ?? { status: 500 };
      const send = () => {
        // The agent may have aborted the request while this reply was delayed.
        if (res.destroyed) return;
        if (r.chunks) {
          res.writeHead(r.status ?? 200, { 'content-type': 'text/event-stream', ...r.headers });
          for (const c of r.chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
          res.end('data: [DONE]\n\n');
        } else {
          res.writeHead(r.status ?? 200, { 'content-type': 'application/json', ...r.headers });
          res.end(r.body ?? '');
        }
      };
      if (r.delayMs) setTimeout(send, r.delayMs);
      else send();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

export const textChunks = (...parts: string[]) =>
  parts.map((content) => ({ choices: [{ index: 0, delta: { content } }] }));

// The arguments arrive in a second delta, the way OpenAI streams them, so the merge is exercised.
export const toolCallChunks = (
  id: string,
  name: string,
  args: string,
  extra: Record<string, unknown> = {},
) => [
  {
    choices: [
      {
        index: 0,
        delta: {
          role: 'assistant',
          tool_calls: [
            { index: 0, id, type: 'function', function: { name, arguments: '' }, ...extra },
          ],
        },
      },
    ],
  },
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args } }] } }] },
  { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
];
