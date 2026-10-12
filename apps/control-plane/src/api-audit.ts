import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ApiOptions } from './api.js';
import { requireUser, type SessionUser, UUID_RE } from './api-session.js';

export const PAGE_SIZE = 50;
const OUTCOMES = [
  'ok',
  'tool_error',
  'denied',
  'timeout',
  'unreachable',
  'disabled',
  'rate_limited',
  'bad_request',
  'upstream_error',
] as const;
const CURSOR_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

const query = z
  .object({
    user: z.string().regex(UUID_RE).optional(),
    server: z.string().min(1).max(64).optional(),
    outcome: z.enum(OUTCOMES).optional(),
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
    cursor: z.string().max(200).optional(),
  })
  .strict();

type Row = {
  id: string;
  ts: string;
  userId: string;
  userEmail: string;
  via: string;
  serverSlug: string;
  toolName: string;
  exposedName: string;
  outcome: string;
  durationMs: number;
  errorMessage: string | null;
  replica: string;
};

// ts keeps microseconds in Postgres. A JS Date would round them away, and a page boundary inside
// one millisecond would then skip or repeat rows, so ts travels as Postgres text.
export function encodeCursor(ts: string, id: string): string {
  return Buffer.from(`${ts}|${id}`, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): { ts: string; id: string } | null {
  const [ts, id, extra] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  if (extra !== undefined || !ts || !id || !CURSOR_TS.test(ts) || !/^\d{1,19}$/.test(id))
    return null;
  return { ts, id };
}

export function auditRoutes(scope: FastifyInstance, o: ApiOptions): void {
  scope.get('/api/audit', { preHandler: requireUser }, async (req, reply) => {
    const q = query.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'bad_request' });
    const cursor = q.data.cursor === undefined ? null : decodeCursor(q.data.cursor);
    if (q.data.cursor !== undefined && !cursor)
      return reply.code(400).send({ error: 'bad_request' });
    const me = req.user as SessionUser;
    // Members see only their own rows, whatever user filter they send (SPEC 9).
    const user = me.role === 'admin' ? (q.data.user ?? null) : me.id;
    const r = await o.pool.query<Row>(
      `select id, to_char(ts at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as ts,
         user_id as "userId", user_email as "userEmail", via, server_slug as "serverSlug",
         tool_name as "toolName", exposed_name as "exposedName", outcome,
         duration_ms as "durationMs", error_message as "errorMessage", replica
       from audit_events
       where ($1::uuid is null or user_id = $1)
         and ($2::text is null or server_slug = $2)
         and ($3::audit_outcome is null or outcome = $3)
         and ($4::timestamptz is null or audit_events.ts >= $4)
         and ($5::timestamptz is null or audit_events.ts < $5)
         and ($6::timestamptz is null or (audit_events.ts, audit_events.id) < ($6, $7::bigint))
       order by audit_events.ts desc, audit_events.id desc
       limit ${PAGE_SIZE + 1}`,
      [
        user,
        q.data.server ?? null,
        q.data.outcome ?? null,
        q.data.from ?? null,
        q.data.to ?? null,
        cursor?.ts ?? null,
        cursor?.id ?? null,
      ],
    );
    const items = r.rows.slice(0, PAGE_SIZE);
    const last = items.at(-1);
    return {
      items,
      nextCursor: r.rows.length > PAGE_SIZE && last ? encodeCursor(last.ts, last.id) : null,
    };
  });
}
