import { afterEach, describe, expect, it } from 'vitest';
import type { Provider } from './config.js';
import { advisedDelayMs, RateLimitedError, streamCompletion } from './llm.js';
import { fakeLlm, textChunks, toolCallChunks, type FakeReply } from './test-llm.js';
import type { FunctionTool } from './tools.js';

const servers: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});
async function llm(script: FakeReply[]) {
  const s = await fakeLlm(script);
  servers.push(s);
  return s;
}

const provider = (baseUrl: string): Provider => ({
  name: 'primary',
  baseUrl,
  model: 'model-1',
  apiKey: 'key-1',
});
const turn = new AbortController().signal;
const tool: FunctionTool = {
  type: 'function',
  function: { name: 'main__get_info', description: 'Store info.' },
};
const user = [{ role: 'user' as const, content: 'hi' }];
const quiet = { signal: turn, onText: () => {} };

describe('streamCompletion', () => {
  it('streams text and sends the model, messages, tools and key', async () => {
    const s = await llm([{ chunks: textChunks('Hel', 'lo') }]);
    const deltas: string[] = [];
    const c = await streamCompletion(
      provider(s.url),
      { messages: user, tools: [tool], reasoningEffort: 'low' },
      { signal: turn, onText: (d) => deltas.push(d) },
    );
    expect(deltas).toEqual(['Hel', 'lo']);
    expect(c).toEqual({ text: 'Hello', toolCalls: [] });
    const r = s.requests[0]!;
    expect(r.url).toBe('/v1/chat/completions');
    expect(r.headers.authorization).toBe('Bearer key-1');
    expect(r.body).toEqual({
      model: 'model-1',
      messages: user,
      stream: true,
      tools: [tool],
      tool_choice: 'auto',
      reasoning_effort: 'low',
    });
  });

  it('sends no tools, tool_choice or reasoning_effort when there are none', async () => {
    const s = await llm([{ chunks: textChunks('ok') }]);
    await streamCompletion(
      provider(s.url),
      { messages: user, tools: [], reasoningEffort: null },
      quiet,
    );
    expect(s.requests[0]!.body).toEqual({ model: 'model-1', messages: user, stream: true });
  });

  it('merges tool call deltas and keeps provider fields such as a thought signature', async () => {
    const extra = { extra_content: { google: { thought_signature: 'sig-1' } } };
    const s = await llm([{ chunks: toolCallChunks('c1', 'main__get_info', '{"a":1}', extra) }]);
    const c = await streamCompletion(
      provider(s.url),
      { messages: user, tools: [tool], reasoningEffort: null },
      quiet,
    );
    expect(c).toEqual({
      text: '',
      toolCalls: [
        {
          id: 'c1',
          type: 'function',
          function: { name: 'main__get_info', arguments: '{"a":1}' },
          ...extra,
        },
      ],
    });
  });

  it('names calls that arrive without an id or index', async () => {
    const s = await llm([
      {
        chunks: [
          {
            choices: [
              { delta: { tool_calls: [{ function: { name: 'fx__get_info', arguments: '{}' } }] } },
            ],
          },
        ],
      },
    ]);
    const c = await streamCompletion(
      provider(s.url),
      { messages: user, tools: [tool], reasoningEffort: null },
      quiet,
    );
    expect(c.toolCalls).toEqual([
      {
        id: expect.stringMatching(/^call_[0-9a-f]{8}$/),
        type: 'function',
        function: { name: 'fx__get_info', arguments: '{}' },
      },
    ]);
  });

  it('throws RateLimitedError with the advised wait on 429', async () => {
    const s = await llm([{ status: 429, headers: { 'retry-after': '7' }, body: '{}' }]);
    const err = await streamCompletion(
      provider(s.url),
      { messages: user, tools: [], reasoningEffort: null },
      quiet,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitedError);
    expect(err).toMatchObject({ provider: 'primary', waitMs: 7000 });
  });

  it('names the status and the provider message on other errors', async () => {
    const s = await llm([
      { status: 400, body: JSON.stringify([{ error: { message: 'Invalid value at tools[0]' } }]) },
    ]);
    await expect(
      streamCompletion(
        provider(s.url),
        { messages: user, tools: [], reasoningEffort: null },
        quiet,
      ),
    ).rejects.toThrow('The primary LLM provider answered 400: Invalid value at tools[0]');
  });

  it('turns an error inside the stream into LlmError', async () => {
    const s = await llm([{ chunks: [{ error: { message: 'overloaded' } }] }]);
    await expect(
      streamCompletion(
        provider(s.url),
        { messages: user, tools: [], reasoningEffort: null },
        quiet,
      ),
    ).rejects.toThrow('The primary LLM provider failed mid-answer: overloaded');
  });

  it('reports an unreachable provider by error code only', async () => {
    // Port 9 is on fetch's blocked list ("bad port"), so use a port that was just released.
    const closed = await fakeLlm([]);
    await closed.close();
    await expect(
      streamCompletion(
        provider(closed.url),
        { messages: user, tools: [], reasoningEffort: null },
        quiet,
      ),
    ).rejects.toThrow('Could not reach the primary LLM provider (ECONNREFUSED).');
  });
});

describe('advisedDelayMs', () => {
  const now = Date.parse('2026-10-12T10:00:00Z');
  const h = (v?: string) => new Headers(v === undefined ? {} : { 'retry-after': v });
  it.each([
    ['Retry-After seconds', h('3'), '', 3000],
    ['Retry-After date', h('Mon, 12 Oct 2026 10:00:05 GMT'), '', 5000],
    [
      'Gemini retryDelay',
      h(),
      '{"error":{"details":[{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"39s"}]}}',
      39000,
    ],
    ['Groq message', h(), '{"error":{"message":"Please try again in 7m12.5s."}}', 432500],
    ['milliseconds', h(), 'Please try again in 250ms', 250],
    ['nothing advised', h(), '{}', 2000],
  ])('%s', (_name, headers, body, ms) => {
    expect(advisedDelayMs(headers, body, now)).toBe(ms);
  });
});
