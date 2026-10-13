import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HelmError, helmCli, helmDetail } from './helm.js';

// Records its arguments and acts out one helm behaviour per FAKE_HELM_MODE.
const FAKE = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_HELM_LOG"
case "$FAKE_HELM_MODE" in
  deployed) echo '{"name":"store-x","info":{"status":"deployed"}}' ;;
  pending) echo '{"info":{"status":"pending-install"}}' ;;
  odd) echo '{"info":{"status":"something-new"}}' ;;
  garbage) echo 'not json' ;;
  absent) echo 'Error: release: not found' >&2; exit 1 ;;
  fail) printf 'kind: Secret with tok-123\\nError: INSTALLATION FAILED: context deadline exceeded tok-123\\n' >&2; exit 1 ;;
  long) printf 'Error: %0400d\\n' 0 >&2; exit 1 ;;
  hang) exec sleep 30 ;;
esac
`;

// Fails the test when the call succeeds, so the assertions on the error always run.
const caught = (p: Promise<unknown>): Promise<HelmError> =>
  p.then(
    () => {
      throw new Error('expected the helm call to fail');
    },
    (e: unknown) => e as HelmError,
  );

describe('helmCli', () => {
  let dir: string;
  let bin: string;
  let log: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fake-helm-'));
    bin = join(dir, 'helm');
    log = join(dir, 'calls.log');
    await writeFile(bin, FAKE);
    await chmod(bin, 0o755);
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const helm = (mode: string) =>
    helmCli({ bin, env: { ...process.env, FAKE_HELM_LOG: log, FAKE_HELM_MODE: mode } });
  const lastCall = async () => (await readFile(log, 'utf8')).trim().split('\n').at(-1);

  it('maps helm status output', async () => {
    expect(await helm('deployed').status('store-x', 'store-x')).toBe('deployed');
    expect(await lastCall()).toBe('status store-x -n store-x -o json');
    expect(await helm('pending').status('store-x', 'store-x')).toBe('pending-install');
    expect(await helm('absent').status('store-x', 'store-x')).toBe('absent');
    expect(await helm('odd').status('store-x', 'store-x')).toBe('unknown');
    await expect(helm('garbage').status('store-x', 'store-x')).rejects.toBeInstanceOf(HelmError);
  });

  it('runs upgrade --install with the SPEC 18 flags', async () => {
    await helm('ok').upgradeInstall({
      release: 'store-x',
      ns: 'store-x',
      chart: '/charts/store',
      valuesFile: '/tmp/v.yaml',
      timeoutSec: 600,
    });
    expect(await lastCall()).toBe(
      'upgrade --install store-x /charts/store -n store-x -f /tmp/v.yaml --wait --timeout 600s',
    );
  });

  it('uninstalls with a foreground wait and ignores a missing release', async () => {
    await helm('ok').uninstall('store-x', 'store-x', 300);
    expect(await lastCall()).toBe(
      'uninstall store-x -n store-x --wait --cascade foreground --ignore-not-found --timeout 300s',
    );
  });

  it('keeps only the last stderr line, with the token replaced', async () => {
    const err = await caught(
      helm('fail').upgradeInstall({
        release: 'store-x',
        ns: 'store-x',
        chart: '/charts/store',
        valuesFile: '/tmp/v.yaml',
        timeoutSec: 600,
        redact: ['tok-123'],
      }),
    );
    expect(err).toBeInstanceOf(HelmError);
    expect(err.detail).toBe('Error: INSTALLATION FAILED: context deadline exceeded [redacted]');
    expect(err.message).not.toContain('tok-123');
  });

  it('cuts a long error to 300 characters', async () => {
    const err = await caught(helm('long').uninstall('store-x', 'store-x', 300));
    expect(err.detail).toHaveLength(300);
  });

  it('stops a helm run on abort', async () => {
    const ac = new AbortController();
    const t0 = performance.now();
    const p = helm('hang').upgradeInstall({
      release: 'store-x',
      ns: 'store-x',
      chart: '/charts/store',
      valuesFile: '/tmp/v.yaml',
      timeoutSec: 600,
      signal: ac.signal,
    });
    setTimeout(() => ac.abort(), 50);
    await expect(p).rejects.toMatchObject({ detail: 'aborted' });
    expect(performance.now() - t0).toBeLessThan(5000);
  });

  it('reports a missing binary without a stack', async () => {
    const err = await caught(helmCli({ bin: join(dir, 'nope') }).status('store-x', 'store-x'));
    expect(err.detail).toBe('spawn ENOENT');
  });
});

describe('helmDetail', () => {
  it('handles empty output', () => {
    expect(helmDetail('\n\n')).toBe('no error output');
  });
});
