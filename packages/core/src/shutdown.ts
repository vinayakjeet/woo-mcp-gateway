import type http from 'node:http';
import { errorCode } from './logging.js';

const SWEEP_MS = 100;
export const DEFAULT_GRACE_MS = 5000;

// Node services run as PID 1 in the pod, where an unhandled SIGTERM is ignored and the pod lingers for the whole grace period.
// Idle keep-alive sockets are swept repeatedly because a socket only becomes idle after its in-flight request ends.
export async function drainServers(opts: {
  servers: http.Server[];
  close: () => Promise<void>;
  graceMs?: number;
}): Promise<void> {
  const sweep = () => opts.servers.forEach((s) => s.closeIdleConnections());
  let deadlineTimer: NodeJS.Timeout | undefined;
  const deadline = new Promise<void>(
    (resolve) => (deadlineTimer = setTimeout(resolve, opts.graceMs ?? DEFAULT_GRACE_MS)),
  );
  const sweeper = setInterval(sweep, SWEEP_MS);
  const closed = opts.close();
  closed.catch(() => {});
  sweep();
  try {
    await Promise.race([closed, deadline]);
  } finally {
    clearTimeout(deadlineTimer);
    clearInterval(sweeper);
    opts.servers.forEach((s) => s.closeAllConnections());
  }
}

export function installGracefulShutdown(opts: {
  servers: http.Server[];
  close: () => Promise<void>;
  graceMs?: number;
  proc?: { on(signal: string, listener: () => void): unknown };
  exit?: (code: number) => void;
}): void {
  const proc = opts.proc ?? process;
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  let started = false;
  for (const signal of ['SIGTERM', 'SIGINT']) {
    proc.on(signal, () => {
      if (started) return;
      started = true;
      console.log(JSON.stringify({ level: 'info', msg: 'shutting down', signal }));
      drainServers(opts).then(
        () => exit(0),
        (err: unknown) => {
          console.error(JSON.stringify({ level: 'error', msg: 'shutdown failed', code: errorCode(err) }));
          exit(1);
        },
      );
    });
  }
}
