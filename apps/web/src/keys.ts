import type { ApiKey, Tone } from './types';

export type KeyStatus = 'active' | 'revoked' | 'expired';

export function keyStatus(k: Pick<ApiKey, 'revokedAt' | 'expiresAt'>, now = Date.now()): KeyStatus {
  if (k.revokedAt) return 'revoked';
  if (k.expiresAt && Date.parse(k.expiresAt) <= now) return 'expired';
  return 'active';
}

export const KEY_TONE: Record<KeyStatus, Tone> = { active: 'ok', revoked: 'off', expired: 'warn' };

// The same bounds as PATCH /api/keys/:id, so a bad value never leaves the form.
export function parseLimit(text: string): number | null {
  if (!/^\d+$/.test(text.trim())) return null;
  const n = Number(text.trim());
  return n >= 1 && n <= 10000 ? n : null;
}
