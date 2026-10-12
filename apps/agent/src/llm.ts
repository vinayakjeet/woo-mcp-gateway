import { randomUUID } from 'node:crypto';
import { errorCode } from '@woo/core';
import type { Provider } from './config.js';
import { UserFacingError } from './errors.js';
import type { FunctionTool } from './tools.js';

export type WireToolCall = {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
  [extra: string]: unknown;
};

export type WireMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: WireToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export type Completion = { text: string; toolCalls: WireToolCall[] };

export class LlmError extends UserFacingError {
  // Transient means the provider itself is down or slow, so the other provider may still answer.
  constructor(
    message: string,
    readonly transient = false,
  ) {
    super(message);
  }
}

export class RateLimitedError extends Error {
  constructor(
    readonly provider: Provider['name'],
    readonly waitMs: number,
  ) {
    super(`${provider} LLM provider is rate limited`);
  }
}

export const LLM_TIMEOUT_MS = 60_000;
const DEFAULT_WAIT_MS = 2000;
const ERROR_BODY_MAX = 4096;
const STANDARD_KEYS = new Set(['index', 'id', 'type', 'function']);

type ToolCallDelta = {
  index?: unknown;
  id?: unknown;
  function?: { name?: unknown; arguments?: unknown };
} & Record<string, unknown>;

type Chunk = {
  error?: { message?: unknown };
  choices?: Array<{ delta?: { content?: unknown; tool_calls?: unknown } }>;
};

// Go-style durations such as 7m12.5s or 250ms, as Groq writes them.
function durationMs(s: string): number {
  let ms = 0;
  for (const m of s.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)) {
    const n = Number(m[1]);
    ms += m[2] === 'h' ? n * 3_600_000 : m[2] === 'm' ? n * 60_000 : m[2] === 's' ? n * 1000 : n;
  }
  return Math.ceil(ms);
}

export function advisedDelayMs(headers: Headers, body: string, now = Date.now()): number {
  const retryAfter = headers.get('retry-after');
  if (retryAfter) {
    const s = Number(retryAfter);
    if (Number.isFinite(s) && s >= 0) return Math.ceil(s * 1000);
    const at = Date.parse(retryAfter);
    if (!Number.isNaN(at)) return Math.max(0, at - now);
  }
  // Gemini sends google.rpc.RetryInfo in the error details; Groq also says it in the message.
  const gemini = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(body);
  if (gemini) return Math.ceil(Number(gemini[1]) * 1000);
  const text = /try again in ((?:\d+(?:\.\d+)?(?:ms|h|m|s))+)/i.exec(body);
  if (text?.[1]) return durationMs(text[1]);
  return DEFAULT_WAIT_MS;
}

const messageOf = (m: unknown) => (typeof m === 'string' ? `: ${m.slice(0, 200)}` : '');

// Gemini's compatibility layer wraps errors in an array; Groq and OpenAI do not.
function providerMessage(body: string): string {
  try {
    const v: unknown = JSON.parse(body);
    const e = (Array.isArray(v) ? v[0] : v) as { error?: { message?: unknown } } | undefined;
    return messageOf(e?.error?.message);
  } catch {
    return '';
  }
}

async function errorBody(res: Response): Promise<string> {
  return (await res.text().catch(() => '')).slice(0, ERROR_BODY_MAX);
}

// The turn's own abort (client gone, deadline) passes through untouched so the caller can tell it apart.
// After text has reached the user, a switch to the other provider would repeat the answer, so the
// error is not marked transient.
function asLlmError(p: Provider, err: unknown, turn: AbortSignal, streamed: boolean): unknown {
  if (turn.aborted || err instanceof LlmError) return err;
  if (err instanceof Error && err.name === 'TimeoutError')
    return new LlmError(
      `The ${p.name} LLM provider did not answer within ${LLM_TIMEOUT_MS / 1000} s.`,
      !streamed,
    );
  return new LlmError(`Could not reach the ${p.name} LLM provider (${errorCode(err)}).`, !streamed);
}

function mergeToolCall(calls: WireToolCall[], d: ToolCallDelta): void {
  const i = typeof d.index === 'number' ? d.index : calls.length;
  const cur = (calls[i] ??= { id: '', type: 'function', function: { name: '', arguments: '' } });
  if (typeof d.id === 'string' && d.id !== '') cur.id = d.id;
  if (typeof d.function?.name === 'string' && cur.function.name === '')
    cur.function.name = d.function.name;
  if (typeof d.function?.arguments === 'string') cur.function.arguments += d.function.arguments;
  // Provider-specific fields, such as Gemini's thought signature in extra_content, go back unchanged.
  for (const [k, v] of Object.entries(d)) if (!STANDARD_KEYS.has(k)) cur[k] = v;
}

// A counter would restart at call_0 on every iteration and collide in the browser's chips.
function finish(text: string, calls: WireToolCall[]): Completion {
  return {
    text,
    toolCalls: calls
      .filter(Boolean)
      .map((c) => ({ ...c, id: c.id || `call_${randomUUID().slice(0, 8)}` })),
  };
}

async function readStream(
  p: Provider,
  body: ReadableStream<Uint8Array>,
  onText: (delta: string) => void,
): Promise<Completion> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const calls: WireToolCall[] = [];
  let text = '';
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return finish(text, calls);
      buf += decoder.decode(value, { stream: true });
      let nl = buf.indexOf('\n');
      while (nl !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        nl = buf.indexOf('\n');
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') return finish(text, calls);
        let chunk: Chunk;
        try {
          chunk = JSON.parse(data) as Chunk;
        } catch {
          throw new LlmError(`The ${p.name} LLM provider sent a malformed stream.`);
        }
        if (chunk.error)
          throw new LlmError(
            `The ${p.name} LLM provider failed mid-answer${messageOf(chunk.error.message)}`,
          );
        const delta = chunk.choices?.[0]?.delta;
        if (typeof delta?.content === 'string' && delta.content !== '') {
          text += delta.content;
          onText(delta.content);
        }
        if (Array.isArray(delta?.tool_calls))
          for (const d of delta.tool_calls as ToolCallDelta[]) mergeToolCall(calls, d);
      }
    }
  } finally {
    // Frees the connection when [DONE] arrives before the provider closes the stream.
    void reader.cancel().catch(() => {});
  }
}

export async function streamCompletion(
  p: Provider,
  req: { messages: WireMessage[]; tools: FunctionTool[]; reasoningEffort: string | null },
  o: { signal: AbortSignal; onText: (delta: string) => void; fetch?: typeof fetch },
): Promise<Completion> {
  const signal = AbortSignal.any([o.signal, AbortSignal.timeout(LLM_TIMEOUT_MS)]);
  let streamed = false;
  try {
    const res = await (o.fetch ?? fetch)(`${p.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${p.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: p.model,
        messages: req.messages,
        stream: true,
        ...(req.tools.length > 0 ? { tools: req.tools, tool_choice: 'auto' } : {}),
        ...(req.reasoningEffort ? { reasoning_effort: req.reasoningEffort } : {}),
      }),
      signal,
      redirect: 'error',
    });
    if (res.status === 429)
      throw new RateLimitedError(p.name, advisedDelayMs(res.headers, await errorBody(res)));
    if (!res.ok || !res.body)
      throw new LlmError(
        `The ${p.name} LLM provider answered ${res.status}${providerMessage(await errorBody(res))}`,
        res.status >= 500,
      );
    return await readStream(p, res.body, (delta) => {
      streamed = true;
      o.onText(delta);
    });
  } catch (err) {
    if (err instanceof RateLimitedError) throw err;
    throw asLlmError(p, err, o.signal, streamed);
  }
}
