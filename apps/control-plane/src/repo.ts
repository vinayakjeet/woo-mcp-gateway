import { schemaReady, schema } from '@woo/core/db';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import type { Deps } from './app.js';

export function pgDeps(pool: pg.Pool): Deps {
  const db = drizzle(pool, { schema });
  return {
    // Ready means the schema this build needs exists, not only that Postgres answers.
    ping: () => schemaReady(pool),
    async findUserByEmail(email) {
      const [row] = await db
        .select({
          id: schema.users.id,
          email: schema.users.email,
          name: schema.users.name,
          role: schema.users.role,
          status: schema.users.status,
          passwordHash: schema.users.passwordHash,
        })
        .from(schema.users)
        .where(eq(schema.users.email, email))
        .limit(1);
      return row ?? null;
    },
    async createSession(s) {
      await db.insert(schema.sessions).values(s);
    },
  };
}
