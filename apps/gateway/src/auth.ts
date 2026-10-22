import {
  ACCESS_TOKEN_TYP,
  AGENT_JWT_TYP,
  AgentJwtError,
  OAuthJwtError,
  errorCode,
  oauthKeys,
  parseApiKey,
  verifyAccessToken,
  verifyAgentJwt,
  verifyApiKeySecret,
  type OAuthKeys,
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
  // Set only while OAuth is on. Without it an access token is refused like any unknown token.
  oauthIssuer?: string;
  log: Log;
  cacheTtlMs?: number;
  negativeTtlMs?: number;
  negativeMax?: number;
  touchEveryMs?: number;
  now?: () => number;
};

// Only dispatches. Each branch verifies the whole token itself.
function jwtTyp(token: string): unknown {
  const [h, p, s, extra] = token.split('.');
  if (!h || !p || !s || extra !== undefined) return undefined;
  try {
    return (JSON.parse(Buffer.from(h, 'base64url').toString('utf8')) as { typ?: unknown }).typ;
  } catch {
    return undefined;
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
  // The same JWT_SIGNING_KEY the control-plane signs with gives this replica the public key (decision A1).
  private readonly oauth: { keys: OAuthKeys; issuer: string } | null;

  constructor(private readonly o: AuthenticatorOptions) {
    this.ttl = o.cacheTtlMs ?? 10_000;
    this.touchEvery = o.touchEveryMs ?? 60_000;
    this.negativeTtl = o.negativeTtlMs ?? 5_000;
    this.negativeMax = o.negativeMax ?? 1000;
    this.now = o.now ?? Date.now;
    this.oauth = o.oauthIssuer ? { keys: oauthKeys(o.jwtKey), issuer: o.oauthIssuer } : null;
  }

  async authenticate(header: string | undefined): Promise<Principal | null> {
    const token = /^Bearer (\S+)$/i.exec(header ?? '')?.[1];
    if (!token) return null;
    if (token.startsWith('urk_')) return this.apiKey(token);
    const typ = jwtTyp(token);
    if (typ === AGENT_JWT_TYP) return this.agent(token);
    if (typ === ACCESS_TOKEN_TYP && this.oauth) return this.accessToken(token, this.oauth);
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
    return this.withoutKey(sub, 'agent');
  }

  private async accessToken(
    token: string,
    oauth: { keys: OAuthKeys; issuer: string },
  ): Promise<Principal | null> {
    let claims: { sub: string; client_id: string; iat: number };
    try {
      claims = verifyAccessToken(token, {
        publicKey: oauth.keys.publicKey,
        kid: oauth.keys.kid,
        iss: oauth.issuer,
        aud: this.o.audience,
        now: Math.floor(this.now() / 1000),
      });
    } catch (err) {
      if (err instanceof OAuthJwtError) return null;
      throw err;
    }
    return this.withoutKey(claims.sub, 'oauth', { clientId: claims.client_id, iat: claims.iat });
  }

  // Agent and OAuth tokens outlive a disabled user, so the user row is read on every request.
  // An access token also needs its consent row (Connected apps, Revoke), read in the same query.
  private async withoutKey(
    sub: string,
    via: 'agent' | 'oauth',
    grant?: { clientId: string; iat: number },
  ): Promise<Principal | null> {
    if (!UUID_RE.test(sub)) return null;
    const u = schema.users;
    const c = schema.oauthConsents;
    const [user] = await this.o.db
      .select({
        id: u.id,
        email: u.email,
        role: u.role,
        status: u.status,
        approvedAt: c.createdAt,
      })
      .from(u)
      .leftJoin(c, and(eq(c.userId, u.id), eq(c.clientId, grant?.clientId ?? '')))
      .where(eq(u.id, sub))
      .limit(1);
    if (!user || user.status !== 'active') return null;
    if (grant) {
      // No row: the user revoked the app. A token minted before the latest approval belongs to a
      // grant that was revoked and approved again. iat has whole seconds, so compare whole seconds.
      if (!user.approvedAt || grant.iat < Math.floor(user.approvedAt.getTime() / 1000)) return null;
    }
    // No key to carry a mode, so these follow the visible-count rule (the tool search design).
    return {
      userId: user.id,
      email: user.email,
      role: user.role,
      via,
      apiKeyId: null,
      toolMode: 'auto',
      rateLimitPerMin: null,
    };
  }
}
