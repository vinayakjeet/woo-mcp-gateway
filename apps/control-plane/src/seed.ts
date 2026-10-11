import { hash } from '@node-rs/argon2';
import { encryptSecret, isValidSlug } from '@woo/core';
import { schema } from '@woo/core/db';
import { count } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { z } from 'zod';

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
      authType: s.auth.type,
      authHeaderName: s.auth.type === 'header' ? s.auth.headerName : null,
      authSecretEnc: s.auth.type === 'none' ? null : encryptSecret(s.auth.secret, kek, s.slug),
    };
    // The secret is rewritten on every run, which also re-encrypts rows that predate the slug as aad.
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
