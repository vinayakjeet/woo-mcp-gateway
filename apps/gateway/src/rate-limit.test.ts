import { schema } from '@woo/core/db';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { callLimiter, pruneRateCounters, RateLimiter, rateSubject } from './rate-limit.js';
import { migratedDatabase, TEST_DATABASE_URL } from './test-db.js';
import type { Db, Principal } from './types.js';

const principal = (p: Partial<Principal>): Principal => ({
  userId: 'u1',
  email: 'a@example.com',
  role: 'member',
  via: 'api_key',
  apiKeyId: 'k1',
  toolMode: 'full',
  rateLimitPerMin: null,
  ...p,
});

describe('rateSubject', () => {
  it('is key:<id> for a key and user:<id> for the agent', () => {
    expect(rateSubject(principal({ via: 'api_key', apiKeyId: 'k9' }))).toBe('key:k9');
    expect(rateSubject(principal({ via: 'agent', apiKeyId: null, userId: 'u7' }))).toBe('user:u7');
  });
});

describe('callLimiter', () => {
  const hit = vi.fn(async () => ({ allowed: true, count: 1, retryInSeconds: 30 }));

  it("uses the key's own limit before the default", async () => {
    hit.mockClear();
    await callLimiter({ hit }, 60).check(principal({ apiKeyId: 'k5', rateLimitPerMin: 5 }));
    expect(hit).toHaveBeenCalledWith('key:k5', 5);
    await callLimiter({ hit }, 60).check(principal({ apiKeyId: 'k6', rateLimitPerMin: null }));
    expect(hit).toHaveBeenLastCalledWith('key:k6', 60);
  });

  it('counts the agent under user:<id> with the default', async () => {
    hit.mockClear();
    await callLimiter({ hit }, 60).check(
      principal({ via: 'agent', apiKeyId: null, userId: 'u3', rateLimitPerMin: null }),
    );
    expect(hit).toHaveBeenCalledWith('user:u3', 60);
  });
});

describe.skipIf(!TEST_DATABASE_URL)('RateLimiter', () => {
  let pool: pg.Pool;
  let db: Db;

  beforeAll(async () => {
    ({ pool, db } = await migratedDatabase('gw_rate_limit_test'));
  });
  afterAll(async () => {
    await pool.end();
  });

  it('allows hits 1 to N and refuses N+1 with retry seconds from 1 to 60', async () => {
    const limiter = new RateLimiter(db);
    for (let i = 1; i <= 3; i++) {
      const r = await limiter.hit('key:n-plus-one', 3);
      expect(r.allowed).toBe(true);
      expect(r.count).toBe(i);
    }
    const over = await limiter.hit('key:n-plus-one', 3);
    expect(over.allowed).toBe(false);
    expect(over.count).toBe(4);
    expect(over.retryInSeconds).toBeGreaterThanOrEqual(1);
    expect(over.retryInSeconds).toBeLessThanOrEqual(60);
  });

  it('does not let a full counter in the previous minute limit the current one', async () => {
    await db.execute(sql`
      insert into rate_counters (subject, window_start, count)
      values ('key:old', date_trunc('minute', now()) - interval '1 minute', 1000)`);
    const r = await new RateLimiter(db).hit('key:old', 2);
    expect(r).toMatchObject({ allowed: true, count: 1 });
  });

  it('shares the count between two limiter instances on one database', async () => {
    const a = new RateLimiter(db);
    const b = new RateLimiter(db);
    expect((await a.hit('key:shared', 2)).allowed).toBe(true);
    expect((await b.hit('key:shared', 2)).allowed).toBe(true);
    expect((await a.hit('key:shared', 2)).allowed).toBe(false);
  });

  it('allows exactly 20 of 50 parallel hits with limit 20', async () => {
    const limiter = new RateLimiter(db);
    const results = await Promise.all(
      Array.from({ length: 50 }, () => limiter.hit('key:parallel', 20)),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(20);
    expect(new Set(results.map((r) => r.count)).size).toBe(50);
  });

  it('keeps subjects independent', async () => {
    const limiter = new RateLimiter(db);
    expect((await limiter.hit('key:one', 1)).allowed).toBe(true);
    expect((await limiter.hit('key:one', 1)).allowed).toBe(false);
    expect((await limiter.hit('key:two', 1)).allowed).toBe(true);
    expect((await limiter.hit('user:one', 1)).allowed).toBe(true);
  });

  it('prunes windows older than 2 minutes and keeps the current one', async () => {
    await db.delete(schema.rateCounters);
    await db.execute(sql`
      insert into rate_counters (subject, window_start, count) values
        ('key:p', date_trunc('minute', now()) - interval '5 minutes', 1),
        ('key:p', date_trunc('minute', now()) - interval '3 minutes', 1),
        ('key:p', date_trunc('minute', now()) - interval '1 minute', 1)`);
    await new RateLimiter(db).hit('key:p', 10);
    const deleted = await pruneRateCounters(db);
    expect(deleted).toBe(2);
    const left = await db.select().from(schema.rateCounters);
    expect(left).toHaveLength(2);
  });
});
