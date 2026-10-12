import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Bulkhead, BulkheadFullError, CircuitBreaker } from './resilience.js';

describe('CircuitBreaker', () => {
  let t = 0;
  const now = () => t;
  beforeEach(() => {
    t = 0;
  });

  const fail = (b: CircuitBreaker, n: number) => {
    for (let i = 0; i < n; i++) {
      expect(b.tryAcquire()).toBe(true);
      b.failure();
    }
  };

  it('opens after five consecutive failures and fails fast for 30 s', () => {
    const b = new CircuitBreaker({ now });
    fail(b, 4);
    expect(b.isOpen).toBe(false);
    fail(b, 1);
    expect(b.isOpen).toBe(true);
    expect(b.tryAcquire()).toBe(false);
    t = 29_999;
    expect(b.tryAcquire()).toBe(false);
  });

  it('lets exactly one trial call through after 30 s and closes on success', () => {
    const b = new CircuitBreaker({ now });
    fail(b, 5);
    t = 30_000;
    expect(b.tryAcquire()).toBe(true);
    expect(b.tryAcquire()).toBe(false);
    b.success();
    expect(b.isOpen).toBe(false);
    expect(b.tryAcquire()).toBe(true);
  });

  it('reopens for another 30 s when the trial fails', () => {
    const b = new CircuitBreaker({ now });
    fail(b, 5);
    t = 30_000;
    expect(b.tryAcquire()).toBe(true);
    b.failure();
    t = 59_999;
    expect(b.tryAcquire()).toBe(false);
    t = 60_000;
    expect(b.tryAcquire()).toBe(true);
  });

  it('counts only consecutive failures', () => {
    const b = new CircuitBreaker({ now });
    fail(b, 4);
    b.success();
    fail(b, 4);
    expect(b.isOpen).toBe(false);
  });

  it('frees the trial slot on release without deciding', () => {
    const b = new CircuitBreaker({ now });
    fail(b, 5);
    t = 30_000;
    expect(b.tryAcquire()).toBe(true);
    b.release();
    expect(b.isOpen).toBe(true);
    expect(b.tryAcquire()).toBe(true);
  });
});

describe('Bulkhead', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function gate() {
    let open!: () => void;
    const p = new Promise<void>((r) => (open = r));
    return { p, open };
  }

  it('runs eight calls at once and queues the ninth until one finishes', async () => {
    const b = new Bulkhead();
    const g = gate();
    const running = Array.from({ length: 8 }, () => b.run(() => g.p));
    let ninthStarted = false;
    const ninth = b.run(async () => {
      ninthStarted = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(b.inFlight).toBe(8);
    expect(b.queued).toBe(1);
    expect(ninthStarted).toBe(false);
    g.open();
    await Promise.all(running);
    await ninth;
    expect(ninthStarted).toBe(true);
    expect(b.inFlight).toBe(0);
  });

  it('rejects a queued call after 2 s', async () => {
    const b = new Bulkhead();
    const g = gate();
    const running = Array.from({ length: 8 }, () => b.run(() => g.p));
    const ninth = b.run(async () => 'ran');
    const assertion = expect(ninth).rejects.toBeInstanceOf(BulkheadFullError);
    await vi.advanceTimersByTimeAsync(2000);
    await assertion;
    expect(b.queued).toBe(0);
    g.open();
    await Promise.all(running);
  });

  it('rejects at once when 32 calls already wait', async () => {
    const b = new Bulkhead();
    const g = gate();
    const running = Array.from({ length: 8 }, () => b.run(() => g.p));
    const waiting = Array.from({ length: 32 }, () => b.run(async () => 'ran'));
    await vi.advanceTimersByTimeAsync(0);
    expect(b.queued).toBe(32);
    await expect(b.run(async () => 'late')).rejects.toBeInstanceOf(BulkheadFullError);
    expect(b.queued).toBe(32);
    g.open();
    await Promise.all([...running, ...waiting]);
    expect(b.inFlight).toBe(0);
  });

  it('leaves the queue when the caller aborts', async () => {
    const b = new Bulkhead({ limit: 1 });
    const g = gate();
    const first = b.run(() => g.p);
    const ac = new AbortController();
    const second = b.run(async () => 'ran', ac.signal);
    const assertion = expect(second).rejects.toThrow('client went away');
    ac.abort(new Error('client went away'));
    await assertion;
    expect(b.queued).toBe(0);
    g.open();
    await first;
  });

  it('frees the slot when the call throws', async () => {
    const b = new Bulkhead({ limit: 1 });
    await expect(
      b.run(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(b.inFlight).toBe(0);
    await expect(b.run(async () => 'next')).resolves.toBe('next');
  });
});
