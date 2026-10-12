import { setTimeout as sleep } from 'node:timers/promises';
import type { Provider } from './config.js';
import {
  LlmError,
  RateLimitedError,
  streamCompletion,
  type Completion,
  type WireMessage,
} from './llm.js';
import type { FunctionTool } from './tools.js';

export const MAX_RETRY_WAIT_MS = 30_000;
// Gemini answers 503 for a few seconds at a time when a model is overloaded, so one short retry
// often succeeds where an immediate switch to the fallback would use up its smaller token quota.
export const UNAVAILABLE_RETRY_MS = 2000;

type AssistantWire = Extract<WireMessage, { role: 'assistant' }>;
// Assistant messages remember who wrote them: provider-specific tool call fields go back only there.
// History from the browser has no tag, and toWire treats an untagged message as written by nobody.
export type ConvoMessage =
  Exclude<WireMessage, { role: 'assistant' }> | (AssistantWire & { from?: Provider['name'] });

export type Turn = Completion & { provider: Provider['name'] };
export type CallOptions = { signal: AbortSignal; onText: (delta: string) => void };
export type Completer = {
  complete(messages: ConvoMessage[], tools: FunctionTool[], o: CallOptions): Promise<Turn>;
};

export type ChatModelOptions = {
  primary: Provider;
  fallback: Provider | null;
  reasoningEffort: string | null;
  fetch?: typeof fetch;
  wait?: (ms: number, signal: AbortSignal) => Promise<unknown>;
};

const seconds = (ms: number) => Math.max(1, Math.ceil(ms / 1000));
const defaultWait = (ms: number, signal: AbortSignal) => sleep(ms, undefined, { signal });

export function toWire(messages: ConvoMessage[], target: Provider['name']): WireMessage[] {
  return messages.map((m): WireMessage => {
    if (m.role !== 'assistant') return m;
    const message: AssistantWire = { role: 'assistant', content: m.content };
    if (m.tool_calls)
      message.tool_calls =
        m.from === target
          ? m.tool_calls
          : m.tool_calls.map((c) => ({ id: c.id, type: c.type, function: c.function }));
    return message;
  });
}

// One instance per chat turn. Once the fallback answers, it keeps the rest of the turn.
export class ChatModel implements Completer {
  private onFallback = false;
  private primaryWaitMs = 0;
  private primaryDown = false;

  constructor(private readonly o: ChatModelOptions) {}

  async complete(messages: ConvoMessage[], tools: FunctionTool[], o: CallOptions): Promise<Turn> {
    if (!this.onFallback) {
      try {
        const answer = await this.tryPrimary(messages, tools, o);
        if (answer) return answer;
      } catch (err) {
        // A 5xx, an unreachable host or a timeout is the provider's fault, so the other one may answer.
        // Other errors, such as a 400, would fail the same way there.
        if (!(err instanceof LlmError && err.transient && this.o.fallback)) throw err;
        this.primaryDown = true;
      }
    }
    const fallback = this.o.fallback;
    if (!fallback)
      throw new LlmError(
        `The LLM provider is rate limited. Try again in ${seconds(this.primaryWaitMs)} s.`,
      );
    this.onFallback = true;
    try {
      return await this.call(fallback, messages, tools, o);
    } catch (err) {
      if (!(err instanceof RateLimitedError)) throw err;
      if (this.primaryDown)
        throw new LlmError(
          `The primary LLM provider failed and the fallback is rate limited. Try again in ${seconds(err.waitMs)} s.`,
        );
      const ms = Math.min(err.waitMs, this.primaryWaitMs);
      throw new LlmError(`Both LLM providers are rate limited. Try again in ${seconds(ms)} s.`);
    }
  }

  // A 503 gets one retry after a short wait. The second failure goes to the caller as it is.
  private async tryPrimary(
    messages: ConvoMessage[],
    tools: FunctionTool[],
    o: CallOptions,
  ): Promise<Turn | null> {
    try {
      return await this.fromPrimary(messages, tools, o);
    } catch (err) {
      if (!(err instanceof LlmError && err.status === 503)) throw err;
      await (this.o.wait ?? defaultWait)(UNAVAILABLE_RETRY_MS, o.signal);
      return this.fromPrimary(messages, tools, o);
    }
  }

  // Null means the primary is still rate limited after its one retry.
  private async fromPrimary(
    messages: ConvoMessage[],
    tools: FunctionTool[],
    o: CallOptions,
  ): Promise<Turn | null> {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt === 1) {
        // A wait this long is a quota, not a burst. Holding the turn would also outlive the agent token.
        if (this.primaryWaitMs > MAX_RETRY_WAIT_MS) return null;
        await (this.o.wait ?? defaultWait)(this.primaryWaitMs, o.signal);
      }
      try {
        return await this.call(this.o.primary, messages, tools, o);
      } catch (err) {
        if (!(err instanceof RateLimitedError)) throw err;
        this.primaryWaitMs = err.waitMs;
      }
    }
    return null;
  }

  private async call(
    p: Provider,
    messages: ConvoMessage[],
    tools: FunctionTool[],
    o: CallOptions,
  ): Promise<Turn> {
    const c = await streamCompletion(
      p,
      { messages: toWire(messages, p.name), tools, reasoningEffort: this.o.reasoningEffort },
      { ...o, fetch: this.o.fetch },
    );
    return { ...c, provider: p.name };
  }
}
