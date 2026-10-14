import { execFile } from 'node:child_process';

export type ReleaseStatus =
  | 'absent'
  | 'deployed'
  | 'failed'
  | 'pending-install'
  | 'pending-upgrade'
  | 'pending-rollback'
  | 'uninstalling'
  | 'uninstalled'
  | 'superseded'
  | 'unknown';

const KNOWN = new Set<string>([
  'deployed',
  'failed',
  'pending-install',
  'pending-upgrade',
  'pending-rollback',
  'uninstalling',
  'uninstalled',
  'superseded',
]);

export type InstallOptions = {
  release: string;
  ns: string;
  chart: string;
  valuesFile: string;
  timeoutSec: number;
  redact?: string[];
  signal?: AbortSignal;
};

export interface Helm {
  status(release: string, ns: string, signal?: AbortSignal): Promise<ReleaseStatus>;
  upgradeInstall(o: InstallOptions): Promise<void>;
  uninstall(release: string, ns: string, timeoutSec: number, signal?: AbortSignal): Promise<void>;
}

export class HelmError extends Error {
  constructor(
    readonly op: string,
    readonly detail: string,
  ) {
    super(`helm ${op} failed: ${detail}`);
  }
}

// helm's stderr can quote rendered manifests, so only its last line leaves this module, cut to
// 300 characters, with every secret replaced.
export function helmDetail(stderr: string, redact: string[] = []): string {
  let line =
    stderr
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .at(-1) ?? 'no error output';
  for (const s of redact) if (s) line = line.split(s).join('[redacted]');
  return line.slice(0, 300);
}

type Run = { ok: boolean; stdout: string; stderr: string };

export function helmCli(o: { bin?: string; env?: NodeJS.ProcessEnv } = {}): Helm {
  const run = (args: string[], timeoutSec: number, signal?: AbortSignal): Promise<Run> =>
    new Promise((resolve) => {
      execFile(
        o.bin ?? 'helm',
        args,
        {
          env: o.env ?? process.env,
          // helm has its own --timeout; this one only stops a helm that hangs past it.
          timeout: (timeoutSec + 60) * 1000,
          maxBuffer: 8 * 1024 * 1024,
          signal,
        },
        (err, stdout, stderr) => {
          if (!err) return resolve({ ok: true, stdout, stderr });
          const e = err as NodeJS.ErrnoException & { killed?: boolean };
          if (e.name === 'AbortError') return resolve({ ok: false, stdout, stderr: 'aborted' });
          if (e.killed) return resolve({ ok: false, stdout, stderr: `${stderr}\nhelm timed out` });
          // A spawn failure (no helm binary) has a string code and no stderr.
          if (typeof e.code === 'string') {
            return resolve({ ok: false, stdout, stderr: `spawn ${e.code}` });
          }
          resolve({ ok: false, stdout, stderr });
        },
      );
    });

  return {
    async status(release, ns, signal) {
      const r = await run(['status', release, '-n', ns, '-o', 'json'], 60, signal);
      if (!r.ok) {
        if (r.stderr.includes('release: not found')) return 'absent';
        throw new HelmError('status', helmDetail(r.stderr));
      }
      let s: unknown;
      try {
        s = (JSON.parse(r.stdout) as { info?: { status?: unknown } }).info?.status;
      } catch {
        throw new HelmError('status', 'output is not JSON');
      }
      return typeof s === 'string' && KNOWN.has(s) ? (s as ReleaseStatus) : 'unknown';
    },
    async upgradeInstall(i) {
      const r = await run(
        [
          'upgrade',
          '--install',
          i.release,
          i.chart,
          '-n',
          i.ns,
          '-f',
          i.valuesFile,
          '--wait',
          '--timeout',
          `${i.timeoutSec}s`,
        ],
        i.timeoutSec,
        i.signal,
      );
      if (!r.ok) throw new HelmError('install', helmDetail(r.stderr, i.redact));
    },
    async uninstall(release, ns, timeoutSec, signal) {
      // Foreground waits for the pods too. Otherwise a reinstall starts while old pods still
      // count against the namespace quota (limits.memory 2Gi) and its pods are refused.
      const r = await run(
        [
          'uninstall',
          release,
          '-n',
          ns,
          '--wait',
          '--cascade',
          'foreground',
          '--ignore-not-found',
          '--timeout',
          `${timeoutSec}s`,
        ],
        timeoutSec,
        signal,
      );
      if (!r.ok) throw new HelmError('uninstall', helmDetail(r.stderr));
    },
  };
}
