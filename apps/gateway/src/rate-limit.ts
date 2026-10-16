import { sql } from 'drizzle-orm';
import type { Db, Principal } from './types.js';

export type RateResult = { allowed: boolean; count: number; retryInSeconds: number };

// The window start comes from Postgres, not from the replica's clock, so replicas with skewed
// clocks still agree on which window a hit belongs to.
export class RateLimiter {
  constructor(private readonly db: Db) {}

  async hit(subject: string, limit: number): Promise<RateResult> {
    const res = await this.db.execute<{ count: number; retry: number }>(sql`
      insert into rate_counters (subject, window_start, count)
      values (${subject}, date_trunc('minute', now()), 1)
      on conflict (subject, window_start) do update set count = rate_counters.count + 1
      returning count,
        greatest(1, ceil(60 - extract(epoch from (clock_timestamp() - window_start))))::int as retry`);
    const row = res.rows[0];
    if (!row) throw new Error('rate counter upsert returned no row');
    return {
      allowed: row.count <= limit,
      count: row.count,
      retryInSeconds: Math.min(60, row.retry),
    };
  }
}

export function rateSubject(p: Principal): string {
  // Only a key has an id of its own: agent and OAuth calls share the user's bucket.
  return p.via === 'api_key' ? `key:${p.apiKeyId}` : `user:${p.userId}`;
}

// The seam the call path uses. The key's own limit beats the default.
export type CallLimiter = {
  check(p: Principal): Promise<{ allowed: boolean; retryInSeconds: number }>;
};

export function callLimiter(limiter: Pick<RateLimiter, 'hit'>, defaultLimit: number): CallLimiter {
  return { check: (p) => limiter.hit(rateSubject(p), p.rateLimitPerMin ?? defaultLimit) };
}

// Two minutes keeps the previous window around for a debugging query and costs a few rows.
export async function pruneRateCounters(db: Db): Promise<number> {
  const res = await db.execute(
    sql`delete from rate_counters where window_start < now() - interval '2 minutes'`,
  );
  return res.rowCount ?? 0;
}
