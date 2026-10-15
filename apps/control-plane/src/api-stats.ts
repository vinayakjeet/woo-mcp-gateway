import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ApiOptions } from './api.js';
import { requireUser } from './api-session.js';

export const DEFAULT_WINDOW_MINUTES = 60;
export const MAX_WINDOW_MINUTES = 1440;
// Outcomes where the call reached the upstream or tried to. A denied or rate limited call never
// waited on a server, so it says nothing about the server's health or speed.
const ATTEMPTED = `('ok', 'tool_error', 'timeout', 'unreachable', 'upstream_error')`;

const query = z
  .object({
    window: z
      .string()
      .regex(/^[1-9]\d{0,3}m$/)
      .refine((w) => Number.parseInt(w, 10) <= MAX_WINDOW_MINUTES)
      .optional(),
  })
  .strict();

// percentile_cont interpolates, so 955 can arrive as 954.9999999999999. A tenth of a ms is plenty.
const tenth = (v: number | null) => (v === null ? null : Math.round(v * 10) / 10);

type ServerRow = {
  slug: string;
  name: string;
  kind: string;
  enabled: boolean;
  state: string | null;
  errorKind: string | null;
  errorMessage: string | null;
  checkedAt: string | null;
  calls: string;
  attempted: string;
  ok: string;
  p50: number | null;
  p95: number | null;
};

// SPEC 14 and 20: aggregates from audit_events, so the Health page works without Prometheus. Every
// role may read them: no user, email or argument leaves this route. Rows with an empty slug are
// search_tools calls, which belong to no server.
export function statsRoutes(scope: FastifyInstance, o: ApiOptions): void {
  scope.get('/api/stats/servers', { preHandler: requireUser }, async (req, reply) => {
    const q = query.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'bad_request' });
    const minutes = q.data.window ? Number.parseInt(q.data.window, 10) : DEFAULT_WINDOW_MINUTES;
    const servers = await o.pool.query<ServerRow>(
      `select m.slug, m.name, m.kind, m.enabled, st.state,
         st.error_kind as "errorKind", st.error_message as "errorMessage",
         to_char(st.checked_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "checkedAt",
         coalesce(a.calls, 0)::text as calls, coalesce(a.attempted, 0)::text as attempted,
         coalesce(a.ok, 0)::text as ok, a.p50, a.p95
       from mcp_servers m
       left join mcp_server_status st on st.server_id = m.id
       left join (
         select server_slug,
           count(*) as calls,
           count(*) filter (where outcome in ${ATTEMPTED}) as attempted,
           count(*) filter (where outcome = 'ok') as ok,
           percentile_cont(0.5) within group (order by duration_ms)
             filter (where outcome in ${ATTEMPTED}) as p50,
           percentile_cont(0.95) within group (order by duration_ms)
             filter (where outcome in ${ATTEMPTED}) as p95
         from audit_events
         where ts >= now() - $1 * interval '1 minute' and server_slug <> ''
         group by server_slug
       ) a on a.server_slug = m.slug
       order by m.slug`,
      [minutes],
    );
    const counts = await o.pool.query<{ slug: string; outcome: string; n: string }>(
      `select server_slug as slug, outcome::text as outcome, count(*)::text as n
       from audit_events
       where ts >= now() - $1 * interval '1 minute' and server_slug <> ''
       group by server_slug, outcome`,
      [minutes],
    );
    const outcomes = new Map<string, Record<string, number>>();
    for (const c of counts.rows) {
      const m = outcomes.get(c.slug) ?? {};
      m[c.outcome] = Number(c.n);
      outcomes.set(c.slug, m);
    }
    return {
      windowMinutes: minutes,
      servers: servers.rows.map((r) => {
        const calls = Number(r.calls);
        const attempted = Number(r.attempted);
        return {
          slug: r.slug,
          name: r.name,
          kind: r.kind,
          enabled: r.enabled,
          state: r.state,
          errorKind: r.errorKind,
          errorMessage: r.errorMessage,
          checkedAt: r.checkedAt,
          calls,
          callsPerMinute: calls / minutes,
          outcomes: outcomes.get(r.slug) ?? {},
          errorRate: attempted === 0 ? null : (attempted - Number(r.ok)) / attempted,
          p50Ms: tenth(r.p50),
          p95Ms: tenth(r.p95),
        };
      }),
    };
  });
}
