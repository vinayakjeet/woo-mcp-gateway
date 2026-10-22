import { randomBytes } from 'node:crypto';
import { encryptSecret } from '@woo/core';
import type { FastifyInstance } from 'fastify';
import type { ApiOptions } from './api.js';
import { parseId, requireAdmin, type SessionUser } from './api-session.js';
import { notify, withTx } from './db.js';
import { loadHostedConfig, parseHostedInput, RESERVED_ENV } from './hosted-input.js';
import { hostedUrl } from './hosted-manifests.js';

type HostedRow = {
  id: string;
  slug: string;
  image: string;
  port: number;
  path: string;
  env: { plain?: { name: string; value: string }[]; secretNames?: string[] } | null;
  cpu: string;
  memory: string;
  status: 'pending' | 'ready' | 'failed' | 'deleting';
  reason: string | null;
  serverId: string | null;
  createdAt: Date;
};

// secret_env_enc is never selected: the list has no way to return a secret value.
const HOSTED_SELECT = `select id, slug, image, port, path, env, cpu_limit as cpu, memory_limit as memory,
    status, status_reason as reason, server_id as "serverId", created_at as "createdAt"
  from hosted_servers`;

// The registry row that the gateway reads. Same defaults as a store row (the data model, decision 17).
const HOSTED_TIMEOUT_MS = 15000;

// Thrown inside the transaction so the rows inserted so far roll back with it.
class SlugTaken extends Error {}

function hostedView(r: HostedRow) {
  return {
    id: r.id,
    slug: r.slug,
    image: r.image,
    port: r.port,
    path: r.path,
    env: r.env?.plain ?? [],
    // Names only. The values exist in Postgres as ciphertext and in the Kubernetes Secret.
    secretEnvNames: r.env?.secretNames ?? [],
    cpu: r.cpu,
    memory: r.memory,
    status: r.status,
    reason: r.reason,
    serverId: r.serverId,
    url: hostedUrl(r.slug, r.port, r.path),
    createdAt: r.createdAt,
  };
}

const formatCpu = (millis: number): string => `${millis}m`;
const formatMemory = (bytes: number): string =>
  bytes % 1024 ** 2 === 0 ? `${bytes / 1024 ** 2}Mi` : String(bytes);

export async function getHosted(o: ApiOptions, id: string) {
  const r = await o.pool.query<HostedRow>(`${HOSTED_SELECT} where id = $1`, [id]);
  return r.rows[0] ? hostedView(r.rows[0]) : null;
}

export function hostedRoutes(scope: FastifyInstance, o: ApiOptions): void {
  const config = o.hosted ?? loadHostedConfig({});

  scope.get('/api/hosted', { preHandler: requireAdmin }, async () => {
    const r = await o.pool.query<HostedRow>(`${HOSTED_SELECT} order by created_at`);
    return {
      servers: r.rows.map(hostedView),
      limits: {
        allowedImagePrefixes: config.allowedImagePrefixes,
        maxCpu: formatCpu(config.maxCpuMillis),
        maxMemory: formatMemory(config.maxMemoryBytes),
      },
    };
  });

  scope.post('/api/hosted', { preHandler: requireAdmin }, async (req, reply) => {
    // The RBAC for the mcp-hosted objects ships with the provisioner (decision 19).
    if (!o.provisioner) return reply.code(409).send({ error: 'hosted_unavailable' });
    const p = parseHostedInput(config, req.body);
    if (!p.ok) {
      return reply.code(400).send(
        p.error === 'image_not_allowed'
          ? {
              error: p.error,
              issues: p.issues,
              allowedImagePrefixes: config.allowedImagePrefixes,
            }
          : { error: p.error, issues: p.issues },
      );
    }
    const v = p.value;
    const user = req.user as SessionUser;
    // Generated once, like a store token. It is the gateway's bearer for this server and the
    // container's MCP_SHARED_TOKEN, and it is only ever stored encrypted.
    const token = randomBytes(32).toString('hex');
    const secrets: Record<string, string> = Object.fromEntries(
      v.secretEnv.map((e) => [e.name, e.value]),
    );
    secrets[RESERVED_ENV] = token;
    let id: string;
    try {
      id = await withTx(o.pool, async (c) => {
        // The server row is disabled until the reconcile pass sees the Deployment available.
        const m = await c.query<{ id: string }>(
          `insert into mcp_servers (slug, name, url, kind, managed, enabled, auth_type,
             auth_secret_enc, timeout_ms, protocol_mode, approval, created_by)
           values ($1, $1, $2, 'hosted', true, false, 'bearer', $3, $4, 'legacy', 'approved', $5)
           on conflict (slug) do nothing returning id`,
          [
            v.slug,
            hostedUrl(v.slug, v.port, v.path),
            // The slug is the AAD, as for every upstream secret (core crypto.ts).
            encryptSecret(token, o.kek, v.slug),
            HOSTED_TIMEOUT_MS,
            user.id,
          ],
        );
        const serverId = m.rows[0]?.id;
        if (!serverId) throw new SlugTaken();
        const h = await c.query<{ id: string }>(
          `insert into hosted_servers (slug, image, port, path, env, secret_env_enc, cpu_limit,
             memory_limit, server_id)
           values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9)
           on conflict (slug) do nothing returning id`,
          [
            v.slug,
            v.image,
            v.port,
            v.path,
            JSON.stringify({ plain: v.env, secretNames: v.secretEnv.map((e) => e.name) }),
            // A different AAD from the server row's secret, so neither ciphertext can stand in
            // for the other.
            encryptSecret(JSON.stringify(secrets), o.kek, `hosted:${v.slug}`),
            v.cpu,
            v.memory,
            serverId,
          ],
        );
        const hostedId = h.rows[0]?.id;
        if (!hostedId) throw new SlugTaken();
        await notify(c, 'hosted_changed', hostedId);
        return hostedId;
      });
    } catch (err) {
      if (err instanceof SlugTaken) return reply.code(409).send({ error: 'slug_taken' });
      throw err;
    }
    return reply.code(201).send({ server: await getHosted(o, id) });
  });

  scope.delete('/api/hosted/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const id = parseId(req.params);
    if (!id) return reply.code(404).send({ error: 'not_found' });
    const found = await withTx(o.pool, async (c) => {
      const cur = await c.query<{ status: string; serverId: string | null }>(
        'select status, server_id as "serverId" from hosted_servers where id = $1 for update',
        [id],
      );
      const h = cur.rows[0];
      if (!h) return false;
      if (h.status === 'deleting') return true;
      await c.query(
        `update hosted_servers set status = 'deleting', status_reason = null where id = $1`,
        [id],
      );
      // The tools disappear before any Kubernetes work starts (deregister, then delete).
      const m = await c.query<{ id: string }>(
        'delete from mcp_servers where id = $1 returning id',
        [h.serverId],
      );
      for (const row of m.rows) await notify(c, 'registry_changed', row.id);
      await notify(c, 'hosted_changed', id);
      return true;
    });
    if (!found) return reply.code(404).send({ error: 'not_found' });
    return reply.code(202).send({ server: await getHosted(o, id) });
  });
}
