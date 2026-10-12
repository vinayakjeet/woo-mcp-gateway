import { describe, expect, it } from 'vitest';
import { copyText } from './clipboard';

function env(secure: boolean, asyncOk: boolean | null, execOk = true) {
  const calls: string[] = [];
  return {
    calls,
    env: {
      secure,
      writeText:
        asyncOk === null
          ? undefined
          : async (t: string) => {
              calls.push(`async:${t}`);
              if (!asyncOk) throw new Error('denied');
            },
      execCopy: (t: string) => {
        calls.push(`exec:${t}`);
        return execOk;
      },
    },
  };
}

describe('copyText', () => {
  it('uses the async clipboard in a secure context', async () => {
    const e = env(true, true);
    expect(await copyText('k', e.env)).toBe(true);
    expect(e.calls).toEqual(['async:k']);
  });
  it('falls back to execCommand on plain http, where navigator.clipboard is missing', async () => {
    const e = env(false, null);
    expect(await copyText('k', e.env)).toBe(true);
    expect(e.calls).toEqual(['exec:k']);
  });
  it('falls back when the async clipboard refuses', async () => {
    const e = env(true, false);
    expect(await copyText('k', e.env)).toBe(true);
    expect(e.calls).toEqual(['async:k', 'exec:k']);
  });
  it('reports failure when nothing can copy', async () => {
    expect(await copyText('k', env(false, null, false).env)).toBe(false);
  });
});
