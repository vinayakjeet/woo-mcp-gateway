export type FlagKind = 'hidden_unicode' | 'long_description' | 'suspicious_phrase';

export interface Flag {
  kind: FlagKind;
  detail: string;
}

export const MAX_DESCRIPTION_LENGTH = 1500;

const PHRASES = ['ignore previous', 'do not tell the user', '<important>', 'system prompt'];

// Tag characters, zero-width and directional marks, invisible operators and the
// byte order mark. None of them show up on screen, so an admin cannot see them.
const hiddenRe = /[\u{E0000}-\u{E007F}\u{200B}-\u{200F}\u{2060}-\u{2064}\u{FEFF}]/gu;

export function screenTool(tool: { description?: string | null }): Flag[] {
  const text = tool.description ?? '';
  const flags: Flag[] = [];

  const hidden = [...text.matchAll(hiddenRe)];
  if (hidden.length > 0) {
    const first = hidden[0]?.[0]?.codePointAt(0) ?? 0;
    flags.push({
      kind: 'hidden_unicode',
      detail: `${hidden.length} hidden character(s), first U+${first.toString(16).toUpperCase().padStart(4, '0')}`,
    });
  }

  if (text.length > MAX_DESCRIPTION_LENGTH) {
    flags.push({
      kind: 'long_description',
      detail: `${text.length} characters, limit ${MAX_DESCRIPTION_LENGTH}`,
    });
  }

  const lower = text.toLowerCase();
  for (const phrase of PHRASES) {
    if (lower.includes(phrase)) flags.push({ kind: 'suspicious_phrase', detail: phrase });
  }
  return flags;
}
