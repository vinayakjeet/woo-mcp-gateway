import {
  InMemoryServerEventBus,
  type ServerEvent,
  type ServerEventBus,
} from '@modelcontextprotocol/server';
import { errorCode } from '@woo/core';
import type { Log, Principal } from './types.js';

export type ListenHubOptions = {
  authenticate(header: string | undefined): Promise<Principal | null>;
  log: Log;
  // Open listen streams one key (or one user, for a token without a key) may hold on this replica.
  maxPerKey?: number;
  // How often every open stream's credential is checked again.
  recheckMs?: number;
  // Events inside this window give one notification.
  debounceMs?: number;
};

type Stream = { subject: string; header: string; res: { destroy(): unknown } };

// The change-event bus for subscriptions/listen. The SDK handler owns the streams, so the two
// things it cannot do live here: a stream is authenticated once, and this hub checks the
// credential again before every send and on a timer, and it caps the streams per key.
// An event carries no data: each client lists its own tools again, and gets its own filtered list.
export class ListenHub implements ServerEventBus {
  private readonly inner = new InMemoryServerEventBus();
  private readonly streams = new Set<Stream>();
  private readonly timer: NodeJS.Timeout;
  private pending: NodeJS.Timeout | undefined;
  private sweeping: Promise<void> | undefined;
  private closed = false;
  private readonly max: number;
  private readonly debounceMs: number;

  constructor(private readonly o: ListenHubOptions) {
    this.max = o.maxPerKey ?? 3;
    this.debounceMs = o.debounceMs ?? 100;
    this.timer = setInterval(() => void this.sweep(), o.recheckMs ?? 60_000);
    this.timer.unref();
  }

  get size(): number {
    return this.streams.size;
  }

  // Called with the raw response of a listen request before the SDK serves it. False means the key
  // already holds its share of streams.
  open(
    subject: string,
    header: string,
    res: Stream['res'] & { once(e: 'close', f: () => void): unknown },
  ): boolean {
    let held = 0;
    for (const s of this.streams) if (s.subject === subject) held++;
    if (held >= this.max) return false;
    const stream: Stream = { subject, header, res };
    this.streams.add(stream);
    res.once('close', () => this.streams.delete(stream));
    return true;
  }

  subscribe(listener: (event: ServerEvent) => void): () => void {
    return this.inner.subscribe(listener);
  }

  // Checks every stream first, so a stream whose credential is gone never receives the event.
  publish(event: ServerEvent): void {
    void this.sweep().then(() => {
      if (!this.closed) this.inner.publish(event);
    });
  }

  toolsChanged(): void {
    if (this.pending || this.closed) return;
    this.pending = setTimeout(() => {
      this.pending = undefined;
      this.publish({ kind: 'tools_list_changed' });
    }, this.debounceMs);
    this.pending.unref();
  }

  // After the LISTEN connection was lost, notifications may have been missed: tell every stream once.
  resync(): void {
    this.toolsChanged();
  }

  close(): void {
    this.closed = true;
    clearInterval(this.timer);
    clearTimeout(this.pending);
    this.streams.clear();
  }

  private sweep(): Promise<void> {
    this.sweeping ??= this.check().finally(() => {
      this.sweeping = undefined;
    });
    return this.sweeping;
  }

  // Only a definite "no" closes a stream. A failed check (the database is down) keeps it: the stream
  // carries no data, and a call made on it is authenticated again anyway.
  private async check(): Promise<void> {
    await Promise.all(
      [...this.streams].map(async (s) => {
        try {
          if ((await this.o.authenticate(s.header)) !== null) return;
        } catch (err) {
          this.o.log.warn({ code: errorCode(err) }, 'listen credential check failed');
          return;
        }
        this.streams.delete(s);
        s.res.destroy();
        this.o.log.info({ subject: s.subject }, 'listen stream closed, credential no longer valid');
      }),
    );
  }
}
