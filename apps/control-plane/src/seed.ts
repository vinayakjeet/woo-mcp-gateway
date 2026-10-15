import { hash } from '@node-rs/argon2';
import { SEED_POLICIES, encryptSecret, isValidSlug } from '@woo/core';
import { schema } from '@woo/core/db';
import { count, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';
import { storeNamespace, storeUrl, type StoreDefaults } from './store-values.js';

const auth = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  z.object({ type: z.literal('bearer'), secret: z.string().min(1) }),
  z.object({ type: z.literal('header'), headerName: z.string().min(1), secret: z.string().min(1) }),
]);

const seedServer = z.object({
  slug: z.string().refine(isValidSlug, 'invalid slug'),
  name: z.string().min(1),
  url: z.url(),
  kind: z.enum(['external', 'store', 'hosted', 'system']),
  managed: z.boolean(),
  protocolMode: z.enum(['legacy', 'auto']).default('legacy'),
  auth,
});

export type SeedServer = z.infer<typeof seedServer>;
type Db = NodePgDatabase<typeof schema>;

export function parseSeedServers(json: string): SeedServer[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error('SEED_SERVERS invalid: not JSON');
  }
  const parsed = z.array(seedServer).safeParse(raw);
  if (!parsed.success) {
    // Paths and messages only: an issue's input value could be a token.
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`SEED_SERVERS invalid: ${issues.join('; ')}`);
  }
  return parsed.data;
}

export async function seedServers(db: Db, servers: SeedServer[], kek: Buffer): Promise<void> {
  for (const s of servers) {
    const fields = {
      name: s.name,
      url: s.url,
      kind: s.kind,
      managed: s.managed,
      protocolMode: s.protocolMode,
      authType: s.auth.type,
      authHeaderName: s.auth.type === 'header' ? s.auth.headerName : null,
      authSecretEnc: s.auth.type === 'none' ? null : encryptSecret(s.auth.secret, kek, s.slug),
    };
    // The secret is rewritten on every run, which also re-encrypts rows that predate the slug as aad.
    // protocol_mode is rewritten like url: our own servers speak the 2026 era, and the gateway can
    // only cancel an upstream handler on a timeout in that era.
    // enabled is left out of the update so an admin's choice survives an upgrade.
    await db
      .insert(schema.mcpServers)
      .values({ slug: s.slug, ...fields })
      .onConflictDoUpdate({
        target: schema.mcpServers.slug,
        set: { ...fields, updatedAt: new Date() },
      });
  }
}

export async function seedAdmin(db: Db, email: string, password: string): Promise<boolean> {
  const [row] = await db.select({ n: count() }).from(schema.users);
  if ((row?.n ?? 0) > 0) return false;
  await db.insert(schema.users).values({
    email,
    name: 'Admin',
    role: 'admin',
    status: 'active',
    passwordHash: await hash(password),
  });
  return true;
}

const POLICIES_SEEDED = 'policies_seeded';

// The flag, not the table, decides. A rule an admin deletes (or an empty table after they delete
// all of them) must stay that way across restarts.
export async function seedPolicies(db: Db): Promise<void> {
  await db.transaction(async (tx) => {
    const flagged = await tx
      .insert(schema.platformSettings)
      .values({ key: POLICIES_SEEDED, value: true })
      .onConflictDoNothing()
      .returning({ key: schema.platformSettings.key });
    if (flagged.length === 0) return;
    const rows = await tx
      .insert(schema.toolPolicies)
      .values(SEED_POLICIES.map((r) => ({ ...r })))
      .returning({ id: schema.toolPolicies.id });
    // A gateway can finish its first load between the migration and this seed and then hold an
    // empty rule list, which hides every tool from members. The payload only has to be a uuid.
    await tx.execute(sql`select pg_notify('policies_changed', ${rows[0]!.id})`);
  });
}

// make store installs store-main before the provisioner exists. Each seeded store server gets a
// ready stores row so the Stores page lists it. The reconcile loop reads only provisioning and
// deleting rows, so it never reinstalls an adopted store.
export async function adoptSeededStores(
  db: Db,
  servers: SeedServer[],
  d: StoreDefaults | null,
): Promise<void> {
  if (!d) return;
  for (const s of servers.filter((x) => x.kind === 'store')) {
    await db.execute(sql`
      insert into stores (slug, name, owner_user_id, status, namespace, release, url, last_step, ready_at)
      select ${s.slug}, ${s.name}, u.id, 'ready'::store_status, ${storeNamespace(s.slug)},
             ${storeNamespace(s.slug)}, ${storeUrl(d, s.slug)}, 'adopted', now()
      from users u where u.role = 'admin' and u.status = 'active'
      order by u.created_at limit 1
      on conflict (slug) do nothing`);
    await db.execute(sql`
      update mcp_servers m set store_id = st.id from stores st
      where st.slug = ${s.slug} and m.slug = ${s.slug} and m.store_id is distinct from st.id`);
  }
}
