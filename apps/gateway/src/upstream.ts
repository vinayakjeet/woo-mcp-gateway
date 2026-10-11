import { Client, StreamableHTTPClientTransport, type Tool } from '@modelcontextprotocol/client';
import { errorCode } from '@woo/core';
import { canonicalJson } from './canonical.js';
import { classifyError } from './classify.js';
import { Bulkhead, BulkheadFullError, CircuitBreaker } from './resilience.js';
import type { CallOutcome, ErrorKind, Failure, Log, ServerRecord } from './types.js';

export type UpstreamState = 'pending' | 'connected' | 'unreachable' | 'disabled';

export type UpstreamStatus = {
  state: UpstreamState;
  lastOkAt: Date | null;
  lastErrorAt: Date | null;
  lastError: Failure | null;
  toolCount: number;
};

export type UpstreamOptions = {
  log: Log;
  onTools?: (u: Upstream) => void;
  onStatus?: (u: Upstream, changed: boolean) => void;
  healthIntervalMs?: number;
  healthTimeoutMs?: number;
  failuresToUnreachable?: number;
  backoffMinMs?: number;
  backoffMaxMs?: number;
  breaker?: CircuitBreaker;
  bulkhead?: Bulkhead;
};

// A real call that cannot reach the upstream at all proves it is down; no need to wait for three health checks.
const FAST_PATH: ReadonlySet<ErrorKind> = new Set(['refused', 'dns']);
const BREAKER_FAILURES: ReadonlySet<ErrorKind> = new Set(['timeout', 'refused', 'dns', 'tls']);

export function backoffMs(
  attempt: number,
  minMs: number,
  maxMs: number,
  rand: () => number = Math.random,
): number {
  const ceiling = Math.min(maxMs, minMs * 2 ** attempt);
  // Half fixed, half random, so replicas that lost the same upstream do not reconnect in step.
  return Math.round(ceiling / 2 + (rand() * ceiling) / 2);
}

export function authHeaders(auth: ServerRecord['auth']): Record<string, string> {
  if (auth.type === 'bearer') return { Authorization: `Bearer ${auth.secret}` };
  if (auth.type === 'header') return { [auth.headerName]: auth.secret };
  return {};
}

const byName = (a: Tool, b: Tool) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
const seconds = (ms: number) => `${ms / 1000} s`;

export class Upstream {
  readonly breaker: CircuitBreaker;
  readonly bulkhead: Bulkhead;
  private client: Client | null = null;
  private toolList: Tool[] = [];
  private toolsKey = '';
  private failures = 0;
  private attempt = 0;
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  private lastFailure: Failure | null = null;
  private readonly st: UpstreamStatus;
  private readonly healthIntervalMs: number;
  private readonly healthTimeoutMs: number;
  private readonly threshold: number;
  private readonly backoffMinMs: number;
  private readonly backoffMaxMs: number;

  constructor(
    readonly record: ServerRecord,
    private readonly o: UpstreamOptions,
  ) {
    this.breaker = o.breaker ?? new CircuitBreaker();
    this.bulkhead = o.bulkhead ?? new Bulkhead();
    this.healthIntervalMs = o.healthIntervalMs ?? 10_000;
    this.healthTimeoutMs = o.healthTimeoutMs ?? 3_000;
    this.threshold = o.failuresToUnreachable ?? 3;
    this.backoffMinMs = o.backoffMinMs ?? 1_000;
    this.backoffMaxMs = o.backoffMaxMs ?? 30_000;
    this.st = {
      state: record.enabled ? 'pending' : 'disabled',
      lastOkAt: null,
      lastErrorAt: null,
      lastError: null,
      toolCount: 0,
    };
  }

  get state(): UpstreamState {
    return this.st.state;
  }

  status(): UpstreamStatus {
    return { ...this.st };
  }

  tools(): readonly Tool[] {
    return this.toolList;
  }

  start(): void {
    if (!this.record.enabled) return;
    if (this.record.credentialError) {
      this.o.log.error({ server: this.record.slug }, 'stored credential cannot be decrypted');
      this.fail(
        { kind: 'unknown', message: 'stored credential cannot be decrypted' },
        undefined,
        true,
      );
      return;
    }
    void this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.dropClient();
  }

  async checkHealth(): Promise<void> {
    const client = this.client;
    if (!client || this.stopped) return;
    try {
      const { tools } = await client.listTools(undefined, {
        timeout: this.healthTimeoutMs,
        cacheMode: 'refresh',
      });
      if (this.client !== client) return;
      this.ok(tools);
      this.schedule(this.healthIntervalMs, () => this.checkHealth());
    } catch (err) {
      if (this.client !== client) return;
      this.fail(classifyError(err), err);
      if (this.st.state === 'unreachable') this.reconnect();
      else this.schedule(this.healthIntervalMs, () => this.checkHealth());
    }
  }

  async call(
    name: string,
    args: Record<string, unknown> | undefined,
    signal: AbortSignal,
  ): Promise<CallOutcome> {
    const { slug, timeoutMs } = this.record;
    const client = this.client;
    if (!client || this.st.state !== 'connected' || !this.breaker.tryAcquire())
      return this.unreachable();
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = AbortSignal.any([signal, timeout]);
    try {
      const result = await this.bulkhead.run(
        () => client.callTool({ name, arguments: args }, { signal: combined, timeout: timeoutMs }),
        combined,
      );
      this.breaker.success();
      return { outcome: result.isError ? 'tool_error' : 'ok', result };
    } catch (err) {
      if (signal.aborted) {
        this.breaker.release();
        return { outcome: 'upstream_error', message: 'cancelled by client' };
      }
      if (err instanceof BulkheadFullError) {
        this.breaker.release();
        return { outcome: 'timeout', message: `Server ${slug} is busy` };
      }
      const f: Failure = timeout.aborted
        ? { kind: 'timeout', message: `no answer within ${seconds(timeoutMs)}` }
        : classifyError(err);
      if (BREAKER_FAILURES.has(f.kind)) {
        this.breaker.failure();
        this.lastFailure =
          f.kind === 'timeout'
            ? { kind: 'timeout', message: `no answer within ${seconds(timeoutMs)}` }
            : f;
      } else {
        this.breaker.success();
      }
      if (f.kind === 'timeout') {
        return {
          outcome: 'timeout',
          message: `Server ${slug} did not answer within ${seconds(timeoutMs)}`,
        };
      }
      this.o.log.warn(
        { server: slug, tool: name, kind: f.kind, code: errorCode(err) },
        'upstream call failed',
      );
      if (FAST_PATH.has(f.kind)) {
        this.fail(f, undefined, true);
        this.reconnect();
      }
      return {
        outcome: 'upstream_error',
        message: `Server ${slug} failed (${f.kind}: ${f.message})`,
      };
    }
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const client = new Client(
      { name: 'woo-gateway', version: '0.1.0' },
      {
        ...(this.record.protocolMode === 'auto'
          ? { versionNegotiation: { mode: 'auto' as const } }
          : {}),
        listChanged: {
          tools: {
            onChanged: (err: Error | null, tools: Tool[] | null) => {
              if (!err && tools && this.client === client) this.setTools(tools);
            },
          },
        },
      },
    );
    const transport = new StreamableHTTPClientTransport(new URL(this.record.url), {
      requestInit: { headers: authHeaders(this.record.auth) },
    });
    try {
      await client.connect(transport, { timeout: this.healthTimeoutMs });
      const { tools } = await client.listTools(undefined, {
        timeout: this.healthTimeoutMs,
        cacheMode: 'refresh',
      });
      if (this.stopped) {
        await client.close().catch(() => {});
        return;
      }
      this.client = client;
      this.attempt = 0;
      this.ok(tools);
      this.schedule(this.healthIntervalMs, () => this.checkHealth());
    } catch (err) {
      await client.close().catch(() => {});
      if (this.stopped) return;
      this.fail(classifyError(err), err);
      this.schedule(backoffMs(this.attempt++, this.backoffMinMs, this.backoffMaxMs), () =>
        this.connect(),
      );
    }
  }

  private ok(tools: Tool[]): void {
    this.failures = 0;
    this.st.lastOkAt = new Date();
    const changed = this.st.state !== 'connected';
    this.st.state = 'connected';
    this.setTools(tools);
    this.o.onStatus?.(this, changed);
  }

  // immediate: the fast path and broken credentials skip the three-strikes rule.
  private fail(f: Failure, err: unknown, immediate = false): void {
    this.failures = immediate ? Math.max(this.failures + 1, this.threshold) : this.failures + 1;
    this.lastFailure = f;
    this.st.lastError = f;
    this.st.lastErrorAt = new Date();
    if (err !== undefined) {
      this.o.log.warn(
        { server: this.record.slug, kind: f.kind, code: errorCode(err) },
        'upstream check failed',
      );
    }
    const changed = this.failures >= this.threshold && this.st.state !== 'unreachable';
    if (changed) this.st.state = 'unreachable';
    this.o.onStatus?.(this, changed);
  }

  private unreachable(): CallOutcome {
    const f = this.lastFailure ?? {
      kind: 'unknown',
      message: this.st.state === 'pending' ? 'not connected yet' : 'circuit open',
    };
    return {
      outcome: 'unreachable',
      message: `Server ${this.record.slug} is unreachable (${f.kind}: ${f.message})`,
    };
  }

  private reconnect(): void {
    void this.dropClient();
    this.schedule(backoffMs(this.attempt++, this.backoffMinMs, this.backoffMaxMs), () =>
      this.connect(),
    );
  }

  private async dropClient(): Promise<void> {
    const c = this.client;
    this.client = null;
    await c?.close().catch(() => {});
  }

  private schedule(ms: number, fn: () => Promise<void>): void {
    clearTimeout(this.timer);
    if (this.stopped) return;
    this.timer = setTimeout(() => void fn(), ms);
    this.timer.unref();
  }

  private setTools(tools: Tool[]): void {
    const sorted = [...tools].sort(byName);
    const key = canonicalJson(sorted);
    if (key === this.toolsKey) return;
    this.toolsKey = key;
    this.toolList = sorted;
    this.st.toolCount = sorted.length;
    this.o.onTools?.(this);
  }
}
