import {
  AGENT_JWT_TYP,
  AgentJwtError,
  errorCode,
  parseApiKey,
  verifyAgentJwt,
  verifyApiKeySecret,
} from '@woo/core';
import { schema } from '@woo/core/db';
import { and, eq, isNull, lt, or } from 'drizzle-orm';
import { UUID_RE, type Db, type Log, type Principal, type ToolMode } from './types.js';

type KeyRow = {
  id: string;
  secretHash: string;
  expiresAt: Date | null;
  revokedAt: Date | null;
  userId: string;
  email: string;
  role: 'admin' | 'member';
  toolMode: ToolMode;
  rateLimitPerMin: number | null;
  status: 'invited' | 'active' | 'disabled';
};

export type AuthenticatorOptions = {
  db: Db;
  pepper: string;
  jwtKey: string;
  audience: string;
  log: Log;
  cacheTtlMs?: number;
  negativeTtlMs?: number;
  negativeMax?: number;
  touchEveryMs?: number;
  now?: () => number;
};

function isAgentJwt(token: string): boolean {
  const [h, p, s, extra] = token.split('.');
  if (!h || !p || !s || extra !== undefined) return false;
  try {
    return (
      (JSON.parse(Buffer.from(h, 'base64url').toString('utf8')) as { typ?: unknown }).typ ===
      AGENT_JWT_TYP
    );
  } catch {
    return false;
  }
}

export class Authenticator {
  private readonly cache = new Map<string, { row: KeyRow; at: number }>();
  private readonly touched = new Map<string, number>();
  // Prefixes that matched no key. Only unknown prefixes: caching a wrong secret would let anyone lock out the real holder.
  private readonly negative = new Map<string, number>();
  private prunedAt = 0;
  // Bumped on every purge, so a lookup that started before a revocation cannot refill the cache after it.
  private generation = 0;
  private readonly ttl: number;
  private readonly touchEvery: number;
  private readonly negativeTtl: number;
  private readonly negativeMax: number;
  private readonly now: () => number;

  constructor(private readonly o: AuthenticatorOptions) {
    this.ttl = o.cacheTtlMs ?? 10_000;
    this.touchEvery = o.touchEveryMs ?? 60_000;
    this.negativeTtl = o.negativeTtlMs ?? 5_000;
    this.negativeMax = o.negativeMax ?? 1000;
    this.now = o.now ?? Date.now;
  }

  async authenticate(header: string | undefined): Promise<Principal | null> {
    const token = /^Bearer (\S+)$/i.exec(header ?? '')?.[1];
    if (!token) return null;
    if (token.startsWith('urk_')) return this.apiKey(token);
    if (isAgentJwt(token)) return this.agent(token);
    return null;
  }

  purge(keyId: string): void {
    this.generation++;
    for (const [prefix, hit] of this.cache) if (hit.row.id === keyId) this.cache.delete(prefix);
  }

  purgeAll(): void {
    this.generation++;
    this.cache.clear();
    this.negative.clear();
  }

  cacheSizes(): { positive: number; negative: number; touched: number } {
    return { positive: this.cache.size, negative: this.negative.size, touched: this.touched.size };
  }

  private async apiKey(token: string): Promise<Principal | null> {
    const parsed = parseApiKey(token);
    if (!parsed) return null;
    const now = this.now();
    this.prune(now);
    const missedAt = this.negative.get(parsed.prefix);
    if (missedAt !== undefined && now - missedAt < this.negativeTtl) return null;
    let hit = this.cache.get(parsed.prefix);
    if (!hit || now - hit.at >= this.ttl) {
      this.cache.delete(parsed.prefix);
      const gen = this.generation;
      const row = await this.lookup(parsed.prefix);
      if (!row) {
        this.remember(parsed.prefix, now);
        return null;
      }
      if (!this.valid(parsed.secret, row, now)) return null;
      hit = { row, at: now };
      if (gen === this.generation) this.cache.set(parsed.prefix, hit);
    } else if (!this.valid(parsed.secret, hit.row, now)) {
      return null;
    }
    const { row } = hit;
    this.touch(row.id, now);
    return {
      userId: row.userId,
      email: row.email,
      role: row.role,
      via: 'api_key',
      apiKeyId: row.id,
      toolMode: row.toolMode,
      rateLimitPerMin: row.rateLimitPerMin,
    };
  }

  // Without this the maps keep one entry per key ever used until the process restarts.
  private prune(now: number): void {
    if (now - this.prunedAt < this.ttl) return;
    this.prunedAt = now;
    for (const [k, h] of this.cache) if (now - h.at >= this.ttl) this.cache.delete(k);
    for (const [k, at] of this.negative) if (now - at >= this.negativeTtl) this.negative.delete(k);
    for (const [k, at] of this.touched) if (now - at >= this.touchEvery) this.touched.delete(k);
  }

  private remember(prefix: string, now: number): void {
    this.negative.delete(prefix);
    while (this.negative.size >= this.negativeMax) {
      const oldest = this.negative.keys().next().value;
      if (oldest === undefined) break;
      this.negative.delete(oldest);
    }
    this.negative.set(prefix, now);
  }

  private valid(secret: string, row: KeyRow, now: number): boolean {
    return (
      verifyApiKeySecret(secret, this.o.pepper, row.secretHash) &&
      row.revokedAt === null &&
      (row.expiresAt === null || row.expiresAt.getTime() > now) &&
      row.status === 'active'
    );
  }

  private async lookup(prefix: string): Promise<KeyRow | null> {
    const k = schema.apiKeys;
    const u = schema.users;
    const [row] = await this.o.db
      .select({
        id: k.id,
        secretHash: k.secretHash,
        expiresAt: k.expiresAt,
        revokedAt: k.revokedAt,
        userId: u.id,
        email: u.email,
        role: u.role,
        status: u.status,
        toolMode: k.toolMode,
        rateLimitPerMin: k.rateLimitPerMin,
      })
      .from(k)
      .innerJoin(u, eq(u.id, k.userId))
      .where(eq(k.prefix, prefix))
      .limit(1);
    return row ?? null;
  }

  private touch(keyId: string, now: number): void {
    if (now - (this.touched.get(keyId) ?? 0) < this.touchEvery) return;
    this.touched.set(keyId, now);
    const k = schema.apiKeys;
    // The WHERE keeps other replicas from writing again inside the same minute.
    void this.o.db
      .update(k)
      .set({ lastUsedAt: new Date(now) })
      .where(
        and(
          eq(k.id, keyId),
          or(isNull(k.lastUsedAt), lt(k.lastUsedAt, new Date(now - this.touchEvery))),
        ),
      )
      .catch((err: unknown) =>
        this.o.log.warn({ code: errorCode(err) }, 'last_used_at update failed'),
      );
  }

  private async agent(token: string): Promise<Principal | null> {
    let sub: string;
    try {
      sub = verifyAgentJwt(token, {
        key: this.o.jwtKey,
        audience: this.o.audience,
        now: Math.floor(this.now() / 1000),
      }).sub;
    } catch (err) {
      if (err instanceof AgentJwtError) return null;
      throw err;
    }
    if (!UUID_RE.test(sub)) return null;
    const u = schema.users;
    const [user] = await this.o.db
      .select({ id: u.id, email: u.email, role: u.role, status: u.status })
      .from(u)
      .where(eq(u.id, sub))
      .limit(1);
    if (!user || user.status !== 'active') return null;
    // No key to carry a mode, so the agent follows the visible-count rule (SPEC 17).
    return {
      userId: user.id,
      email: user.email,
      role: user.role,
      via: 'agent',
      apiKeyId: null,
      toolMode: 'auto',
      rateLimitPerMin: null,
    };
  }
}
