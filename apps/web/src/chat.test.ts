import { describe, expect, it } from 'vitest';
import {
  applyEvent,
  finishEntry,
  formatArgs,
  formatMs,
  HISTORY_LIMIT,
  historyKey,
  loadHistory,
  parseSse,
  requestMessages,
  saveHistory,
  streamChat,
  type ChatEntry,
  type SseEvent,
} from './chat';

describe('parseSse', () => {
  it('returns complete events and keeps the unfinished tail', () => {
    const a = parseSse('event: text\ndata: {"delta":"He"}\n\nevent: te');
    expect(a.events).toEqual([{ event: 'text', data: '{"delta":"He"}' }]);
    const b = parseSse(a.rest + 'xt\ndata: {"delta":"llo"}\n\n: keepalive\n\n');
    expect(b).toEqual({ events: [{ event: 'text', data: '{"delta":"llo"}' }], rest: '' });
  });
});

describe('applyEvent and finishEntry', () => {
  const ev = (event: string, data: unknown): SseEvent => ({ event, data: JSON.stringify(data) });

  it('builds the reply text and the tool chips with outcome and duration', () => {
    let e: ChatEntry = { role: 'assistant', content: '' };
    e = applyEvent(e, ev('tool_call', { id: 'c1', name: 'main__get_info', arguments: {} }), 1000);
    expect(e.tools).toEqual([
      { id: 'c1', name: 'main__get_info', args: {}, status: 'running', startedAt: 1000 },
    ]);
    e = applyEvent(e, ev('tool_result', { id: 'c1', ok: true, preview: 'Main Store' }), 1820);
    e = applyEvent(e, ev('text', { delta: 'It is ' }), 1900);
    e = applyEvent(e, ev('text', { delta: 'Main Store.' }), 1950);
    e = applyEvent(e, ev('done', {}), 2000);
    expect(e).toEqual({
      role: 'assistant',
      content: 'It is Main Store.',
      tools: [
        {
          id: 'c1',
          name: 'main__get_info',
          args: {},
          status: 'ok',
          preview: 'Main Store',
          startedAt: 1000,
          ms: 820,
        },
      ],
    });
  });

  it('records an error and fails chips left running', () => {
    let e: ChatEntry = { role: 'assistant', content: '' };
    e = applyEvent(e, ev('tool_call', { id: 'c1', name: 'x__y', arguments: 'not json' }), 0);
    e = applyEvent(
      e,
      ev('error', { message: 'This turn took longer than 240 s and was stopped.' }),
      10,
    );
    expect(finishEntry(e)).toMatchObject({
      error: 'This turn took longer than 240 s and was stopped.',
      tools: [{ status: 'failed', args: 'not json' }],
    });
  });

  it('gives a result to the newest running chip when a provider reuses ids', () => {
    let e: ChatEntry = { role: 'assistant', content: '' };
    e = applyEvent(e, ev('tool_call', { id: 'call_0', name: 'a__x', arguments: {} }), 0);
    e = applyEvent(e, ev('tool_result', { id: 'call_0', ok: true, preview: 'first' }), 5);
    e = applyEvent(e, ev('tool_call', { id: 'call_0', name: 'a__y', arguments: {} }), 10);
    e = applyEvent(e, ev('tool_result', { id: 'call_0', ok: false, preview: 'second' }), 30);
    expect(e.tools?.map((t) => [t.name, t.status, t.preview, t.ms])).toEqual([
      ['a__x', 'ok', 'first', 5],
      ['a__y', 'failed', 'second', 20],
    ]);
  });

  it('ignores malformed data', () => {
    const e: ChatEntry = { role: 'assistant', content: 'x' };
    expect(applyEvent(e, { event: 'text', data: '{' }, 0)).toBe(e);
  });
});

describe('history', () => {
  function memory() {
    const m = new Map<string, string>();
    return {
      m,
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
      removeItem: (k: string) => void m.delete(k),
    };
  }

  it('keeps each user separate', () => {
    const s = memory();
    saveHistory(s, 'u1', [{ role: 'user', content: 'mine' }]);
    expect(loadHistory(s, 'u1')).toEqual([{ role: 'user', content: 'mine' }]);
    expect(loadHistory(s, 'u2')).toEqual([]);
    expect([...s.m.keys()]).toEqual([historyKey('u1')]);
  });

  it('keeps the newest 100 entries', () => {
    const s = memory();
    const many = Array.from({ length: 130 }, (_, i): ChatEntry => ({
      role: 'user',
      content: `m${i}`,
    }));
    saveHistory(s, 'u1', many);
    expect(loadHistory(s, 'u1')).toEqual(many.slice(-HISTORY_LIMIT));
  });

  it('survives corrupt data, a missing store and a store that throws', () => {
    const s = memory();
    s.setItem(historyKey('u1'), '{not json');
    expect(loadHistory(s, 'u1')).toEqual([]);
    s.setItem(
      historyKey('u1'),
      JSON.stringify([{ role: 'user', content: 'ok' }, { role: 'robot' }, null]),
    );
    expect(loadHistory(s, 'u1')).toEqual([{ role: 'user', content: 'ok' }]);
    expect(loadHistory(null, 'u1')).toEqual([]);
    const broken = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => {},
    };
    expect(loadHistory(broken, 'u1')).toEqual([]);
    expect(() => saveHistory(broken, 'u1', [])).not.toThrow();
  });
});

describe('requestMessages', () => {
  it('sends the last 10 non-empty messages as role and content only', () => {
    const entries = Array.from({ length: 12 }, (_, i): ChatEntry => ({
      role: i % 2 ? 'assistant' : 'user',
      content: `m${i}`,
      tools: [],
    }));
    entries.splice(11, 0, { role: 'assistant', content: '', error: 'failed' });
    const sent = requestMessages(entries);
    expect(sent).toHaveLength(10);
    expect(sent[0]).toEqual({ role: 'user', content: 'm2' });
    expect(sent.at(-1)).toEqual({ role: 'assistant', content: 'm11' });
  });
});

describe('streamChat', () => {
  const body = (parts: string[]) =>
    new ReadableStream<Uint8Array>({
      start(c) {
        const enc = new TextEncoder();
        for (const p of parts) c.enqueue(enc.encode(p));
        c.close();
      },
    });

  it('posts the messages and hands over events split across reads', async () => {
    let sent: RequestInit | undefined;
    const fake = (async (_url: string, init?: RequestInit) => {
      sent = init;
      return new Response(
        body(['event: text\ndata: {"del', 'ta":"Hi"}\n\nevent: done\ndata: {}\n\n']),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    }) as unknown as typeof fetch;
    const got: SseEvent[] = [];
    await streamChat([{ role: 'user', content: 'hi' }], (e) => got.push(e), { fetch: fake });
    expect(got).toEqual([
      { event: 'text', data: '{"delta":"Hi"}' },
      { event: 'done', data: '{}' },
    ]);
    expect(sent?.method).toBe('POST');
    expect(JSON.parse(String(sent?.body))).toEqual({ messages: [{ role: 'user', content: 'hi' }] });
  });

  it('throws ApiError with the code when the agent refuses', async () => {
    const fake = (async () =>
      new Response(JSON.stringify({ error: 'unauthenticated' }), {
        status: 401,
      })) as unknown as typeof fetch;
    await expect(streamChat([], () => {}, { fetch: fake })).rejects.toMatchObject({
      status: 401,
      code: 'unauthenticated',
    });
  });
});

describe('formatArgs and formatMs', () => {
  it('shows arguments as compact JSON cut at 120 characters', () => {
    expect(formatArgs({ date: 'today' })).toBe('{"date":"today"}');
    expect(formatArgs('not json')).toBe('not json');
    expect(formatArgs({ s: 'x'.repeat(200) })).toHaveLength(120);
  });

  it('shows milliseconds under a second and tenths of seconds above', () => {
    expect([formatMs(undefined), formatMs(820), formatMs(1430)]).toEqual(['', '820 ms', '1.4 s']);
  });
});
