import { ApiError } from './api';

export type ToolChip = {
  id: string;
  name: string;
  args: unknown;
  status: 'running' | 'ok' | 'failed';
  preview?: string;
  startedAt: number;
  ms?: number;
};
export type ChatEntry = {
  role: 'user' | 'assistant';
  content: string;
  tools?: ToolChip[];
  error?: string;
};
export type SseEvent = { event: string; data: string };
export type SentMessage = { role: 'user' | 'assistant'; content: string };
type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export const SEND_LIMIT = 10;
export const HISTORY_LIMIT = 100;

export const historyKey = (userId: string) => `chat:v1:${userId}`;

// Events end with a blank line. A read can stop anywhere, so the unfinished tail waits for the next one.
export function parseSse(buffer: string): { events: SseEvent[]; rest: string } {
  const blocks = buffer.replace(/\r\n/g, '\n').split('\n\n');
  const rest = blocks.pop() ?? '';
  const events: SseEvent[] = [];
  for (const block of blocks) {
    let event = 'message';
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    if (data.length > 0) events.push({ event, data: data.join('\n') });
  }
  return { events, rest };
}

// Durations are measured here, between tool_call and tool_result, so the wire stays as the agent design defines it.
export function applyEvent(entry: ChatEntry, ev: SseEvent, now: number): ChatEntry {
  let d: Record<string, unknown>;
  try {
    d = JSON.parse(ev.data) as Record<string, unknown>;
  } catch {
    return entry;
  }
  const tools = entry.tools ?? [];
  switch (ev.event) {
    case 'text':
      return { ...entry, content: entry.content + String(d.delta ?? '') };
    case 'tool_call':
      return {
        ...entry,
        tools: [
          ...tools,
          {
            id: String(d.id),
            name: String(d.name),
            args: d.arguments,
            status: 'running',
            startedAt: now,
          },
        ],
      };
    case 'tool_result': {
      // A provider may reuse ids across iterations, so the result belongs to the newest running chip.
      const i = tools.findLastIndex((t) => t.id === d.id && t.status === 'running');
      const t = tools[i];
      if (!t) return entry;
      const next = [...tools];
      next[i] = {
        ...t,
        status: d.ok === true ? 'ok' : 'failed',
        preview: String(d.preview ?? ''),
        ms: Math.max(0, Math.round(now - t.startedAt)),
      };
      return { ...entry, tools: next };
    }
    case 'error':
      return { ...entry, error: String(d.message ?? 'The agent failed.') };
    default:
      return entry;
  }
}

// A stream that ends or breaks mid-call leaves no chip spinning in the saved history.
export function finishEntry(entry: ChatEntry): ChatEntry {
  const tools = entry.tools ?? [];
  if (!tools.some((t) => t.status === 'running')) return entry;
  return {
    ...entry,
    tools: tools.map((t): ToolChip => (t.status === 'running' ? { ...t, status: 'failed' } : t)),
  };
}

function isEntry(v: unknown): v is ChatEntry {
  const e = v as ChatEntry | null;
  return (
    e !== null &&
    typeof e === 'object' &&
    (e.role === 'user' || e.role === 'assistant') &&
    typeof e.content === 'string'
  );
}

// Storage can be missing, full or blocked. The chat then works from memory and forgets on reload.
export function loadHistory(store: Store | null, userId: string): ChatEntry[] {
  try {
    const v: unknown = JSON.parse(store?.getItem(historyKey(userId)) ?? '[]');
    return Array.isArray(v) ? v.filter(isEntry) : [];
  } catch {
    return [];
  }
}

export function saveHistory(store: Store | null, userId: string, entries: ChatEntry[]): void {
  try {
    store?.setItem(historyKey(userId), JSON.stringify(entries.slice(-HISTORY_LIMIT)));
  } catch {
    // Same as loadHistory: keep going from memory.
  }
}

export function clearHistory(store: Store | null, userId: string): void {
  try {
    store?.removeItem(historyKey(userId));
  } catch {
    // Same as loadHistory.
  }
}

// The agent keeps only the last 10 as well; sending fewer keeps the request small.
export function requestMessages(entries: ChatEntry[]): SentMessage[] {
  return entries
    .filter((e) => e.content.trim() !== '')
    .slice(-SEND_LIMIT)
    .map(({ role, content }) => ({ role, content }));
}

export async function streamChat(
  messages: SentMessage[],
  onEvent: (ev: SseEvent) => void,
  o: { signal?: AbortSignal; fetch?: typeof fetch } = {},
): Promise<void> {
  const r = await (o.fetch ?? fetch)('/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ messages }),
    signal: o.signal,
  });
  if (!r.ok || !r.body) {
    const data = (await r.json().catch(() => ({}))) as { error?: unknown };
    throw new ApiError(r.status, typeof data.error === 'string' ? data.error : 'http_error');
  }
  const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    const parsed = parseSse(buffer + value);
    buffer = parsed.rest;
    parsed.events.forEach(onEvent);
  }
}

export function formatArgs(args: unknown): string {
  const s = typeof args === 'string' ? args : JSON.stringify(args ?? {});
  return s.length > 120 ? `${s.slice(0, 119)}…` : s;
}

export function formatMs(ms: number | undefined): string {
  if (ms === undefined) return '';
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}
