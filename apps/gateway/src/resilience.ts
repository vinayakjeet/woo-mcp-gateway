export class CircuitBreaker {
  private failures = 0;
  private openedAt: number | null = null;
  private trialRunning = false;
  private readonly threshold: number;
  private readonly openMs: number;
  private readonly now: () => number;

  constructor(o: { threshold?: number; openMs?: number; now?: () => number } = {}) {
    this.threshold = o.threshold ?? 5;
    this.openMs = o.openMs ?? 30_000;
    this.now = o.now ?? Date.now;
  }

  // After the open period one trial call goes through; the rest fail fast until it settles.
  tryAcquire(): boolean {
    if (this.openedAt === null) return true;
    if (this.now() - this.openedAt < this.openMs || this.trialRunning) return false;
    this.trialRunning = true;
    return true;
  }

  success(): void {
    this.failures = 0;
    this.openedAt = null;
    this.trialRunning = false;
  }

  failure(): void {
    this.failures++;
    if (this.trialRunning || this.failures >= this.threshold) this.openedAt = this.now();
    this.trialRunning = false;
  }

  // The call ended without saying anything about the upstream (client cancel, local queue full).
  release(): void {
    this.trialRunning = false;
  }

  get isOpen(): boolean {
    return this.openedAt !== null;
  }
}

export class BulkheadFullError extends Error {
  constructor() {
    super('bulkhead queue wait exceeded');
  }
}

export class Bulkhead {
  readonly limit: number;
  readonly maxWaitMs: number;
  readonly maxQueue: number;
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(o: { limit?: number; maxWaitMs?: number; maxQueue?: number } = {}) {
    this.limit = o.limit ?? 8;
    this.maxWaitMs = o.maxWaitMs ?? 2000;
    this.maxQueue = o.maxQueue ?? 32;
  }

  get inFlight(): number {
    return this.active;
  }

  get queued(): number {
    return this.waiting.length;
  }

  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal);
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }

  private acquire(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve();
    }
    // The wait is capped in time, this caps it in length: a burst cannot park thousands of requests.
    if (this.waiting.length >= this.maxQueue) return Promise.reject(new BulkheadFullError());
    return new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        const i = this.waiting.indexOf(grant);
        if (i >= 0) this.waiting.splice(i, 1);
      };
      const grant = () => {
        cleanup();
        this.active++;
        resolve();
      };
      const onAbort = () => {
        cleanup();
        reject(signal!.reason);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new BulkheadFullError());
      }, this.maxWaitMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiting.push(grant);
    });
  }
}
