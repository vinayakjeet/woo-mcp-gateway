import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ApiOptions } from './api.js';
import { requireUser, UUID_RE, type SessionUser } from './api-session.js';
import { withTx } from './db.js';
import { hostOf, isCimdId } from './oauth-cimd.js';

type GrantRow = {
  clientId: string;
  name: string | null;
  metadataUrl: string | null;
  approvedAt: string;
  lastRefreshedAt: string | null;
};

// One grant is one user and one client, the key of oauth_consents. A refresh is a token row that
// some other row names in replaced_by, so the first token of a grant does not count as one.
const LIST_SQL = `
  select c.client_id as "clientId", cl.name, cl.metadata_url as "metadataUrl",
    to_char(c.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "approvedAt",
    to_char((
      select max(r.created_at) from oauth_refresh_tokens r
      where r.user_id = c.user_id and r.client_id = c.client_id
        and exists (select 1 from oauth_refresh_tokens p where p.replaced_by = r.id)
    ) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "lastRefreshedAt"
  from oauth_consents c
  left join oauth_clients cl on cl.client_id = c.client_id
  where c.user_id = $1
  order by c.created_at desc`;

// A member may only name themselves. Everyone else's id is a 403, not a silent fallback.
// An admin may name any user. Returns the user to act on, or null after answering.
async function targetUser(
  o: ApiOptions,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<{ id: string; email: string } | null> {
  const me = req.user as SessionUser;
  const raw = (req.query as { userId?: unknown } | null)?.userId;
  if (raw === undefined) return { id: me.id, email: me.email };
  if (typeof raw !== 'string' || !UUID_RE.test(raw)) {
    void reply.code(400).send({ error: 'bad_request' });
    return null;
  }
  const id = raw.toLowerCase();
  if (id === me.id) return { id: me.id, email: me.email };
  if (me.role !== 'admin') {
    void reply.code(403).send({ error: 'forbidden' });
    return null;
  }
  const r = await o.pool.query<{ email: string }>('select email from users where id = $1', [id]);
  const email = r.rows[0]?.email;
  if (!email) {
    void reply.code(404).send({ error: 'not_found' });
    return null;
  }
  return { id, email };
}

export function grantRoutes(scope: FastifyInstance, o: ApiOptions): void {
  scope.get('/api/oauth/grants', { preHandler: requireUser }, async (req, reply) => {
    const who = await targetUser(o, req, reply);
    if (!who) return reply;
    const r = await o.pool.query<GrantRow>(LIST_SQL, [who.id]);
    return {
      grants: r.rows.map((g) => {
        const cimd = isCimdId(g.clientId);
        return {
          clientId: g.clientId,
          name: g.name ?? g.clientId,
          kind: cimd ? 'cimd' : 'dcr',
          host: cimd ? hostOf(g.metadataUrl ?? g.clientId) : null,
          approvedAt: g.approvedAt,
          lastRefreshedAt: g.lastRefreshedAt,
        };
      }),
    };
  });

  scope.delete('/api/oauth/grants/:clientId', { preHandler: requireUser }, async (req, reply) => {
    const clientId = (req.params as { clientId?: unknown }).clientId;
    if (typeof clientId !== 'string' || clientId.length === 0 || clientId.length > 2000)
      return reply.code(404).send({ error: 'not_found' });
    const who = await targetUser(o, req, reply);
    if (!who) return reply;
    const actor = req.user as SessionUser;
    const done = await withTx(o.pool, async (c) => {
      const tokens = await c.query(
        `update oauth_refresh_tokens set revoked_at = now()
         where user_id = $1 and client_id = $2 and revoked_at is null`,
        [who.id, clientId],
      );
      // An unredeemed code would otherwise start a new grant after the revoke.
      await c.query(
        `update oauth_codes set used_at = now()
         where user_id = $1 and client_id = $2 and used_at is null`,
        [who.id, clientId],
      );
      const consent = await c.query(
        'delete from oauth_consents where user_id = $1 and client_id = $2',
        [who.id, clientId],
      );
      if ((tokens.rowCount ?? 0) === 0 && (consent.rowCount ?? 0) === 0) return false;
      // The row sits in the grant owner's log. It carries no token and no hash: the client id,
      // the owner and the actor are enough. A blank server slug keeps it out of the Health page.
      await c.query(
        `insert into audit_events
           (request_id, user_id, user_email, via, server_slug, tool_name, exposed_name,
            outcome, duration_ms, error_message, replica)
         values ($1, $2, $3, 'oauth', '', 'oauth_grant_revoked', $4, 'ok', 0, $5, $6)`,
        [
          randomUUID(),
          who.id,
          who.email,
          clientId,
          `revoked by ${actor.email}`.slice(0, 500),
          hostname(),
        ],
      );
      return true;
    });
    return done ? reply.code(204).send() : reply.code(404).send({ error: 'not_found' });
  });
}
