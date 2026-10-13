import { describe, expect, it } from 'vitest';
import {
  BUSY_POLL_MS,
  elapsed,
  IDLE_POLL_MS,
  newIdempotencyKey,
  storePill,
  storeProgress,
  storesPollMs,
} from './stores';

describe('storePill', () => {
  it.each([
    ['provisioning', 'Provisioning', 'warn'],
    ['ready', 'Ready', 'ok'],
    ['failed', 'Failed', 'bad'],
    ['deleting', 'Deleting', 'off'],
  ] as const)('%s is %s', (status, label, tone) => {
    expect(storePill({ status })).toEqual({ label, tone });
  });
});

describe('storesPollMs', () => {
  it('polls fast while a store is provisioning or deleting', () => {
    expect(storesPollMs([{ status: 'ready' }, { status: 'provisioning' }])).toBe(BUSY_POLL_MS);
    expect(storesPollMs([{ status: 'deleting' }])).toBe(BUSY_POLL_MS);
  });
  it('polls slowly otherwise', () => {
    expect(storesPollMs([{ status: 'ready' }, { status: 'failed' }])).toBe(IDLE_POLL_MS);
    expect(storesPollMs([])).toBe(IDLE_POLL_MS);
    expect(storesPollMs(undefined)).toBe(IDLE_POLL_MS);
  });
});

describe('storeProgress', () => {
  const now = Date.parse('2026-10-13T10:02:05Z');
  const at = '2026-10-13T10:00:00.000Z';
  it('shows the step, the attempt and the time so far', () => {
    expect(
      storeProgress(
        { status: 'provisioning', lastStep: 'install', attempt: 1, createdAt: at },
        now,
      ),
    ).toBe('Step install, attempt 2 of 3, 2 min 05 s so far');
  });
  it('says queued before the first step and caps the attempt at 3', () => {
    expect(
      storeProgress({ status: 'provisioning', lastStep: null, attempt: 3, createdAt: at }, now),
    ).toBe('Step queued, attempt 3 of 3, 2 min 05 s so far');
  });
  it('shows the delete step', () => {
    expect(
      storeProgress({ status: 'deleting', lastStep: 'namespace-wait', attempt: 0, createdAt: at }),
    ).toBe('Deleting: step namespace-wait');
  });
  it('is empty for ready and failed stores', () => {
    expect(storeProgress({ status: 'ready', lastStep: 'ready', attempt: 0, createdAt: at })).toBe(
      '',
    );
    expect(
      storeProgress({ status: 'failed', lastStep: 'install', attempt: 3, createdAt: at }),
    ).toBe('');
  });
});

describe('elapsed and keys', () => {
  it('never goes negative', () => {
    expect(elapsed('2026-10-13T10:00:10Z', Date.parse('2026-10-13T10:00:00Z'))).toBe('0 min 00 s');
  });
  it('makes a new UUID each time', () => {
    const a = newIdempotencyKey();
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    expect(newIdempotencyKey()).not.toBe(a);
  });
});
