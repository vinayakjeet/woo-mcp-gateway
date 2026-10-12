import type { Tool } from '@modelcontextprotocol/client';
import type { Provider } from './config.js';
import { UserFacingError } from './errors.js';
import type { WireToolCall } from './llm.js';
import type { Completer, ConvoMessage } from './model.js';
import { recentMessages, systemPrompt, type ChatMessage } from './prompt.js';
import {
  clip,
  PREVIEW_CHARS,
  resultText,
  TOOL_TEXT_MAX,
  toFunctionTools,
  type ToolResultLike,
} from './tools.js';

export const MAX_ITERATIONS = 8;

export type AgentEvent =
  | { type: 'tool_call'; id: string; name: string; arguments: unknown }
  | { type: 'tool_result'; id: string; ok: boolean; preview: string }
  | { type: 'text'; delta: string }
  | { type: 'done' }
  | { type: 'error'; message: string };

export type ToolClient = {
  listTools(signal: AbortSignal): Promise<Tool[]>;
  callTool(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<ToolResultLike>;
};

export type TurnStats = {
  iterations: number;
  toolCalls: number;
  tools: number;
  provider: Provider['name'] | null;
};

type TurnOptions = {
  messages: ChatMessage[];
  email: string;
  now: Date;
  tools: ToolClient;
  model: Completer;
  emit: (e: AgentEvent) => void;
  signal: AbortSignal;
};

function parseArgs(raw: string): Record<string, unknown> | null {
  if (raw.trim() === '') return {};
  try {
    const v: unknown = JSON.parse(raw);
    return v !== null && typeof v === 'object' && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

// SDK errors carry the gateway's message (for example an unknown tool), never the token.
const messageOf = (err: unknown) =>
  (err instanceof Error ? err.message : 'unknown error').slice(0, 300);

async function runTool(call: WireToolCall, o: TurnOptions): Promise<string> {
  const args = parseArgs(call.function.arguments);
  o.emit({
    type: 'tool_call',
    id: call.id,
    name: call.function.name,
    arguments: args ?? call.function.arguments,
  });
  let ok = false;
  let text: string;
  if (!args) {
    text = 'The tool arguments were not a JSON object. Nothing was called.';
  } else {
    try {
      const r = await o.tools.callTool(call.function.name, args, o.signal);
      ok = r.isError !== true;
      text = resultText(r);
    } catch (err) {
      if (o.signal.aborted) throw err;
      text = `The gateway rejected the call: ${messageOf(err)}`;
    }
  }
  o.emit({ type: 'tool_result', id: call.id, ok, preview: text.slice(0, PREVIEW_CHARS) });
  return clip(text, TOOL_TEXT_MAX);
}

// SPEC 13 turn: list tools, then call the model until it answers without tool calls.
export async function runTurn(o: TurnOptions): Promise<TurnStats> {
  const listed = await o.tools.listTools(o.signal).catch((err: unknown) => {
    if (o.signal.aborted) throw err;
    throw new UserFacingError('Could not list tools from the gateway.', { cause: err });
  });
  const tools = toFunctionTools(listed);
  const convo: ConvoMessage[] = [
    { role: 'system', content: systemPrompt(o.now, o.email) },
    ...recentMessages(o.messages),
  ];
  const stats: TurnStats = { iterations: 0, toolCalls: 0, tools: listed.length, provider: null };
  while (stats.iterations < MAX_ITERATIONS) {
    stats.iterations++;
    const turn = await o.model.complete(convo, tools, {
      signal: o.signal,
      onText: (delta) => o.emit({ type: 'text', delta }),
    });
    stats.provider = turn.provider;
    if (turn.toolCalls.length === 0) {
      o.emit({ type: 'done' });
      return stats;
    }
    if (stats.iterations === MAX_ITERATIONS) break;
    convo.push({
      role: 'assistant',
      content: turn.text || null,
      tool_calls: turn.toolCalls,
      from: turn.provider,
    });
    for (const call of turn.toolCalls) {
      stats.toolCalls++;
      convo.push({ role: 'tool', tool_call_id: call.id, content: await runTool(call, o) });
    }
  }
  throw new UserFacingError(`Stopped after ${MAX_ITERATIONS} model calls without a final answer.`);
}
