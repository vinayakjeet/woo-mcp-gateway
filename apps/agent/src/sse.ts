import type { AgentEvent } from './loop.js';

// JSON.stringify escapes newlines, so each frame has exactly one data line.
export function sseFrame(e: AgentEvent): string {
  const { type, ...data } = e;
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}
