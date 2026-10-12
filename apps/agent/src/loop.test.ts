import type { Tool } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import { UserFacingError } from './errors.js';
import type { WireToolCall } from './llm.js';
import { MAX_ITERATIONS, runTurn, type AgentEvent, type ToolClient } from './loop.js';
import type { Completer, ConvoMessage, Turn } from './model.js';
import type { ChatMessage } from './prompt.js';
import type { ToolResultLike } from './tools.js';

const call = (id: string, name: string, args: string): WireToolCall => ({
  id,
  type: 'function',
  function: { name, arguments: args },
});

// Plays the given model turns in order; the last one repeats.
function scripted(turns: Array<Partial<Turn>>) {
  const seen: ConvoMessage[][] = [];
  const model: Completer = {
    async complete(messages, _tools, o) {
      seen.push(structuredClone(messages));
      const t = turns[Math.min(seen.length, turns.length) - 1] ?? {};
      if (t.text) o.onText(t.text);
      return {
        text: t.text ?? '',
        toolCalls: t.toolCalls ?? [],
        provider: t.provider ?? 'primary',
      };
    },
  };
  return { model, seen };
}

function gateway(results: Record<string, ToolResultLike | Error> = {}) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const tools: ToolClient = {
    async listTools() {
      return [
        {
          name: 'main__get_info',
          description: 'Store info.',
          inputSchema: { type: 'object', properties: {} },
        },
      ] as unknown as Tool[];
    },
    async callTool(name, args) {
      calls.push({ name, args });
      const r = results[name] ?? { content: [{ type: 'text', text: 'ok' }] };
      if (r instanceof Error) throw r;
      return r;
    },
  };
  return { tools, calls };
}

async function turn(
  model: Completer,
  tools: ToolClient,
  messages: ChatMessage[] = [{ role: 'user', content: 'What is the main store called?' }],
  events: AgentEvent[] = [],
) {
  const stats = await runTurn({
    messages,
    email: 'a@example.com',
    now: new Date('2026-10-12T10:00:00Z'),
    tools,
    model,
    emit: (e) => events.push(e),
    signal: new AbortController().signal,
  });
  return { events, stats };
}

describe('runTurn', () => {
  it('runs a tool call, feeds the result back and finishes with the answer', async () => {
    const { model, seen } = scripted([
      { toolCalls: [call('c1', 'main__get_info', '{}')] },
      { text: 'It is Main Store.' },
    ]);
    const gw = gateway({
      main__get_info: {
        content: [{ type: 'text', text: 'Main Store' }],
        structuredContent: { currency: 'INR' },
      },
    });
    const { events, stats } = await turn(model, gw.tools);
    expect(events).toEqual([
      { type: 'tool_call', id: 'c1', name: 'main__get_info', arguments: {} },
      { type: 'tool_result', id: 'c1', ok: true, preview: 'Main Store\n{"currency":"INR"}' },
      { type: 'text', delta: 'It is Main Store.' },
      { type: 'done' },
    ]);
    expect(gw.calls).toEqual([{ name: 'main__get_info', args: {} }]);
    expect(seen[1]!.slice(-2)).toEqual([
      {
        role: 'assistant',
        content: null,
        tool_calls: [call('c1', 'main__get_info', '{}')],
        from: 'primary',
      },
      { role: 'tool', tool_call_id: 'c1', content: 'Main Store\n{"currency":"INR"}' },
    ]);
    expect(stats).toEqual({ iterations: 2, toolCalls: 1, tools: 1, provider: 'primary' });
  });

  it('sends the system prompt and at most the last 10 messages', async () => {
    const { model, seen } = scripted([{ text: 'hi' }]);
    const messages = Array.from({ length: 13 }, (_, i): ChatMessage => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `m${i}`,
    }));
    await turn(model, gateway().tools, messages);
    const [system, ...rest] = seen[0]!;
    expect(system).toMatchObject({ role: 'system' });
    expect((system as { content: string }).content).toContain('Asia/Kolkata');
    expect(rest).toEqual(messages.slice(4));
  });

  it('reports a tool error and a gateway exception as failed results and keeps going', async () => {
    const { model, seen } = scripted([
      {
        toolCalls: [
          call('c1', 'main__list_orders', '{"date":"today"}'),
          call('c2', 'ghost__x', '{}'),
        ],
      },
      { text: 'The main store is down.' },
    ]);
    const gw = gateway({
      main__list_orders: {
        content: [{ type: 'text', text: 'upstream_error: store down' }],
        isError: true,
      },
      ghost__x: new Error('Unknown tool: ghost__x'),
    });
    const { events } = await turn(model, gw.tools);
    expect(events.filter((e) => e.type === 'tool_result')).toEqual([
      { type: 'tool_result', id: 'c1', ok: false, preview: 'upstream_error: store down' },
      {
        type: 'tool_result',
        id: 'c2',
        ok: false,
        preview: 'The gateway rejected the call: Unknown tool: ghost__x',
      },
    ]);
    expect(events.at(-1)).toEqual({ type: 'done' });
    expect(seen[1]!.filter((m) => m.role === 'tool')).toHaveLength(2);
  });

  it('does not call the gateway when the arguments are not a JSON object', async () => {
    const { model } = scripted([
      {
        toolCalls: [call('c1', 'main__get_info', 'not json'), call('c2', 'main__get_info', '[1]')],
      },
      { text: 'Sorry.' },
    ]);
    const gw = gateway();
    const { events } = await turn(model, gw.tools);
    expect(gw.calls).toEqual([]);
    expect(events.slice(0, 2)).toEqual([
      { type: 'tool_call', id: 'c1', name: 'main__get_info', arguments: 'not json' },
      {
        type: 'tool_result',
        id: 'c1',
        ok: false,
        preview: 'The tool arguments were not a JSON object. Nothing was called.',
      },
    ]);
  });

  it('previews 500 characters and gives the model at most 6000', async () => {
    const { model, seen } = scripted([
      { toolCalls: [call('c1', 'main__get_info', '')] },
      { text: 'ok' },
    ]);
    const gw = gateway({ main__get_info: { content: [{ type: 'text', text: 'x'.repeat(7000) }] } });
    const { events } = await turn(model, gw.tools);
    const result = events.find((e) => e.type === 'tool_result');
    expect(result && 'preview' in result ? result.preview.length : 0).toBe(500);
    expect(gw.calls).toEqual([{ name: 'main__get_info', args: {} }]);
    expect(seen[1]!.at(-1)).toEqual({
      role: 'tool',
      tool_call_id: 'c1',
      content: `${'x'.repeat(6000)}\n[truncated 1000 characters]`,
    });
  });

  it(`stops after ${MAX_ITERATIONS} model calls without running the last calls`, async () => {
    const { model, seen } = scripted([{ toolCalls: [call('c', 'main__get_info', '{}')] }]);
    const gw = gateway();
    const err = await turn(model, gw.tools).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UserFacingError);
    expect((err as Error).message).toBe('Stopped after 8 model calls without a final answer.');
    expect(seen).toHaveLength(8);
    expect(gw.calls).toHaveLength(7);
  });

  it('says when the gateway tool list fails', async () => {
    const tools: ToolClient = {
      listTools: async () => {
        throw new Error('HTTP 401');
      },
      callTool: async () => ({}),
    };
    const err = await turn(scripted([{ text: 'x' }]).model, tools).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UserFacingError);
    expect((err as Error).message).toBe('Could not list tools from the gateway.');
  });
});
