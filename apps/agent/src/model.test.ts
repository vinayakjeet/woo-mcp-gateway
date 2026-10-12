import { afterEach, describe, expect, it } from 'vitest';
import type { Provider } from './config.js';
import type { WireToolCall } from './llm.js';
import { ChatModel, toWire, type ConvoMessage } from './model.js';
import { fakeLlm, textChunks, type FakeReply } from './test-llm.js';

const servers: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});
async function llm(script: FakeReply[]) {
  const s = await fakeLlm(script);
  servers.push(s);
  return s;
}

const provider = (name: Provider['name'], baseUrl: string): Provider => ({
  name,
  baseUrl,
  model: `${name}-model`,
  apiKey: `${name}-key`,
});
const opts = { signal: new AbortController().signal, onText: () => {} };
const hi: ConvoMessage[] = [{ role: 'user', content: 'hi' }];
const rateLimited = (seconds: number): FakeReply => ({
  status: 429,
  headers: { 'retry-after': String(seconds) },
  body: '{}',
});

function model(primaryUrl: string, fallbackUrl: string | null) {
  const waits: number[] = [];
  const m = new ChatModel({
    primary: provider('primary', primaryUrl),
    fallback: fallbackUrl ? provider('fallback', fallbackUrl) : null,
    reasoningEffort: null,
    wait: async (ms) => {
      waits.push(ms);
    },
  });
  return { m, waits };
}

describe('ChatModel', () => {
  it('retries a 429 from the primary once after the advised wait, then switches to the fallback for the turn', async () => {
    const primary = await llm([rateLimited(2)]);
    const fallback = await llm([{ chunks: textChunks('from fallback') }]);
    const { m, waits } = model(primary.url, fallback.url);
    expect(await m.complete(hi, [], opts)).toEqual({
      text: 'from fallback',
      toolCalls: [],
      provider: 'fallback',
    });
    expect(primary.requests).toHaveLength(2);
    expect(waits).toEqual([2000]);
    expect(fallback.requests[0]!.headers.authorization).toBe('Bearer fallback-key');
    expect(fallback.requests[0]!.body.model).toBe('fallback-model');
    await m.complete(hi, [], opts);
    expect([primary.requests.length, fallback.requests.length]).toEqual([2, 2]);
  });

  it('stays on the primary when the retry succeeds', async () => {
    const primary = await llm([rateLimited(1), { chunks: textChunks('ok') }]);
    const fallback = await llm([{ chunks: textChunks('unused') }]);
    const { m, waits } = model(primary.url, fallback.url);
    expect(await m.complete(hi, [], opts)).toMatchObject({ text: 'ok', provider: 'primary' });
    expect(waits).toEqual([1000]);
    expect(fallback.requests).toHaveLength(0);
  });

  it('goes straight to the fallback when the advised wait is over 30 s', async () => {
    const primary = await llm([rateLimited(45)]);
    const fallback = await llm([{ chunks: textChunks('ok') }]);
    const { m, waits } = model(primary.url, fallback.url);
    expect(await m.complete(hi, [], opts)).toMatchObject({ provider: 'fallback' });
    expect(primary.requests).toHaveLength(1);
    expect(waits).toEqual([]);
  });

  it('gives the shorter wait when both providers are rate limited', async () => {
    const primary = await llm([rateLimited(40)]);
    const fallback = await llm([rateLimited(12)]);
    await expect(model(primary.url, fallback.url).m.complete(hi, [], opts)).rejects.toThrow(
      'Both LLM providers are rate limited. Try again in 12 s.',
    );
  });

  it('says when to try again without a fallback', async () => {
    const primary = await llm([rateLimited(3)]);
    await expect(model(primary.url, null).m.complete(hi, [], opts)).rejects.toThrow(
      'The LLM provider is rate limited. Try again in 3 s.',
    );
  });

  it('does not fall back on errors other than 429', async () => {
    const primary = await llm([{ status: 503, body: '{"error":{"message":"overloaded"}}' }]);
    const fallback = await llm([{ chunks: textChunks('unused') }]);
    await expect(model(primary.url, fallback.url).m.complete(hi, [], opts)).rejects.toThrow(
      'The primary LLM provider answered 503: overloaded',
    );
    expect(fallback.requests).toHaveLength(0);
  });
});

describe('toWire', () => {
  const calls: WireToolCall[] = [
    {
      id: 'c1',
      type: 'function',
      function: { name: 'main__get_info', arguments: '{}' },
      extra_content: { google: { thought_signature: 'sig-1' } },
    },
  ];
  const signed: ConvoMessage = {
    role: 'assistant',
    content: null,
    from: 'primary',
    tool_calls: calls,
  };

  it('echoes provider fields to the provider that wrote them', () => {
    expect(toWire([signed], 'primary')).toEqual([
      { role: 'assistant', content: null, tool_calls: calls },
    ]);
  });

  it('sends only the standard fields to the other provider and never the from tag', () => {
    expect(toWire([{ role: 'user', content: 'hi' }, signed], 'fallback')).toEqual([
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'main__get_info', arguments: '{}' } },
        ],
      },
    ]);
  });
});
