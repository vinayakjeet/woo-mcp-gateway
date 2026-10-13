import { randomBytes } from 'node:crypto';
import { encryptSecret } from '@woo/core';
import type { FastifyInstance } from 'fastify';
import type { ApiOptions } from './api.js';
import { parseId, requireUser, type SessionUser } from './api-session.js';
import { notify, withTx } from './db.js';
import {
  DEADLINE_MINUTES,
  parseIdempotencyKey,
  parseStoreCreate,
  RESERVED_SLUGS,
} from './store-input.js';
import { storeMcpUrl, storeNamespace } from './store-values.js';

export type StoreRow = {
  id: string;
  slug: string;
  name: string;
  status: 'provisioning' | 'ready' | 'failed' | 'deleting';
  statusReason: string | null;
  lastStep: string | null;
  url: string | null;
  attempt: number;
  createdAt: Date;
  readyAt: Date | null;
  deadlineAt: Date | null;
  ownerId: string;
  ownerEmail: string;
};

export const STORE_SELECT = `select s.id, s.slug, s.name, s.status, s.status_reason as "statusReason",
    s.last_step as "lastStep", s.url, s.attempt, s.created_at as "createdAt",
    s.ready_at as "readyAt", s.deadline_at as "deadlineAt", s.owner_user_id as "ownerId",
    u.email::text as "ownerEmail"
  from stores s join users u on u.id = s.owner_user_id`;

// The slug belongs to an existing server: thrown inside the transaction so the stores insert
// rolls back with it.
class SlugTaken extends Error {}

export function storeView(r: StoreRow, user: SessionUser) {
  const mine = user.role === 'admin' || r.ownerId === user.id;
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    status: r.status,
    statusReason: r.statusReason,
    lastStep: r.lastStep,
    url: r.url,
    attempt: r.attempt,
    createdAt: r.createdAt,
    readyAt: r.readyAt,
    deadlineAt: r.deadlineAt,
    owner: { id: r.ownerId, email: r.ownerEmail },
    // Installed with the platform: the page shows its Delete button disabled, not missing.
    seeded: RESERVED_SLUGS.has(r.slug),
    deletable:
      mine && (r.status === 'ready' || r.status === 'failed') && !RESERVED_SLUGS.has(r.slug),
  };
}

export async function getStore(o: ApiOptions, id: string, user: SessionUser) {
  const r = await o.pool.query<StoreRow>(`${STORE_SELECT} where s.id = $1`, [id]);
  return r.rows[0] ? storeView(r.rows[0], user) : null;
}

type CreateOutcome =
  { kind: 'created' | 'existing'; id: string } | { kind: 'limit' } | { kind: 'taken' };

export function storeRoutes(scope: FastifyInstance, o: ApiOptions): void {
  scope.get('/api/stores', { preHandler: requireUser }, async (req) => {
    const user = req.user as SessionUser;
    const r = await o.pool.query<StoreRow>(
      `${STORE_SELECT} where $1::boolean or s.owner_user_id = $2 order by s.created_at`,
      [user.role === 'admin', user.id],
    );
    return { stores: r.rows.map((row) => storeView(row, user)) };
  });

  scope.post('/api/stores', { preHandler: requireUser }, async (req, reply) => {
    const p = o.provisioner;
    if (!p) return reply.code(503).send({ error: 'provisioner_disabled' });
    const key = parseIdempotencyKey(req.headers['idempotency-key']);
    if (!key.ok) return reply.code(400).send({ error: 'invalid_idempotency_key' });
    const body = parseStoreCreate(req.body);
    if (!body.ok) return reply.code(400).send({ error: body.error });
    const { name, slug } = body.value;
    const user = req.user as SessionUser;
    // Generated once and stored only encrypted; the provisioner decrypts it for each install.
    const token = randomBytes(32).toString('hex');
    let out: CreateOutcome;
    try {
      out = await withTx(o.pool, async (c): Promise<CreateOutcome> => {
        // Serializes one user's creates, so parallel requests cannot all pass the key and limit checks.
        await c.query('select id from users where id = $1 for update', [user.id]);
        if (key.key) {
          const same = await c.query<{ id: string }>(
            'select id from stores where owner_user_id = $1 and idempotency_key = $2',
            [user.id, key.key],
          );
          if (same.rows[0]) return { kind: 'existing', id: same.rows[0].id };
        }
        const n = await c.query<{ n: number }>(
          'select count(*)::int as n from stores where owner_user_id = $1',
          [user.id],
        );
        if ((n.rows[0]?.n ?? 0) >= p.maxStoresPerUser) return { kind: 'limit' };
        const s = await c.query<{ id: string }>(
          `insert into stores (slug, name, owner_user_id, status, namespace, release,
             idempotency_key, deadline_at, last_step)
           values ($1, $2, $3, 'provisioning', $4, $4, $5, now() + make_interval(mins => $6), 'queued')
           on conflict (slug) do nothing returning id`,
          [slug, name, user.id, storeNamespace(slug), key.key, DEADLINE_MINUTES],
        );
        const id = s.rows[0]?.id;
        if (!id) return { kind: 'taken' };
        // The slug is the AAD, as for every upstream secret (core crypto.ts).
        const m = await c.query(
          `insert into mcp_servers (slug, name, url, kind, managed, enabled, auth_type,
             auth_secret_enc, protocol_mode, store_id, created_by)
           values ($1, $2, $3, 'store', true, false, 'bearer', $4, 'auto', $5, $6)
           on conflict (slug) do nothing returning id`,
          [slug, name, storeMcpUrl(slug), encryptSecret(token, o.kek, slug), id, user.id],
        );
        if (m.rowCount === 0) throw new SlugTaken();
        await notify(c, 'stores_changed', id);
        return { kind: 'created', id };
      });
    } catch (err) {
      if (err instanceof SlugTaken) return reply.code(409).send({ error: 'name_taken' });
      throw err;
    }
    if (out.kind === 'limit') {
      return reply.code(409).send({ error: 'store_limit', limit: p.maxStoresPerUser });
    }
    if (out.kind === 'taken') return reply.code(409).send({ error: 'name_taken' });
    const store = await getStore(o, out.id, user);
    return reply.code(out.kind === 'created' ? 202 : 200).send({ store });
  });

  scope.delete('/api/stores/:id', { preHandler: requireUser }, async (req, reply) => {
    if (!o.provisioner) return reply.code(503).send({ error: 'provisioner_disabled' });
    const id = parseId(req.params);
    if (!id) return reply.code(404).send({ error: 'not_found' });
    const user = req.user as SessionUser;
    const out = await withTx(o.pool, async (c) => {
      const cur = await c.query<{ slug: string; status: string; ownerId: string }>(
        'select slug, status, owner_user_id as "ownerId" from stores where id = $1 for update',
        [id],
      );
      const s = cur.rows[0];
      // A member learns nothing about another member's store, not even that it exists.
      if (!s || (user.role !== 'admin' && s.ownerId !== user.id)) return 'not_found' as const;
      if (RESERVED_SLUGS.has(s.slug)) return 'seeded_store' as const;
      if (s.status === 'deleting') return 'ok' as const;
      if (s.status === 'provisioning') return 'not_deletable' as const;
      await c.query(
        `update stores set status = 'deleting', last_step = 'queued', status_reason = null,
           updated_at = now() where id = $1`,
        [id],
      );
      // SPEC 18 step 1: the tools disappear before any helm work starts.
      const m = await c.query<{ id: string }>(
        'delete from mcp_servers where store_id = $1 returning id',
        [id],
      );
      for (const row of m.rows) await notify(c, 'registry_changed', row.id);
      await notify(c, 'stores_changed', id);
      return 'ok' as const;
    });
    if (out === 'not_found') return reply.code(404).send({ error: 'not_found' });
    if (out === 'seeded_store') return reply.code(409).send({ error: 'seeded_store' });
    if (out === 'not_deletable') return reply.code(409).send({ error: 'not_deletable' });
    return reply.code(202).send({ store: await getStore(o, id, user) });
  });
}
