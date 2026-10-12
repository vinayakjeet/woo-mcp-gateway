import { generateApiKey } from '@woo/core';
import type pg from 'pg';

const UNIQUE_VIOLATION = '23505';

export async function insertKey(
  db: Pick<pg.Pool, 'query'>,
  o: { userId: string; name: string; pepper: string },
): Promise<{ id: string; key: string; prefix: string }> {
  // The 8 character prefix is unique. A collision is rare, so one retry is enough.
  for (let attempt = 0; ; attempt++) {
    const k = generateApiKey(o.pepper);
    try {
      const ins = await db.query<{ id: string }>(
        `insert into api_keys (user_id, name, prefix, secret_hash) values ($1, $2, $3, $4) returning id`,
        [o.userId, o.name, k.prefix, k.secretHash],
      );
      return { id: ins.rows[0]!.id, key: k.key, prefix: k.prefix };
    } catch (err) {
      if ((err as { code?: string }).code !== UNIQUE_VIOLATION || attempt >= 1) throw err;
    }
  }
}

export async function createKey(
  db: Pick<pg.Pool, 'query'>,
  o: { email: string; name: string; pepper: string },
): Promise<{ id: string; key: string }> {
  const user = await db.query<{ id: string }>(
    `select id from users where email = $1 and status = 'active'`,
    [o.email],
  );
  const userId = user.rows[0]?.id;
  if (!userId) throw new Error('no active user with that email');
  const { id, key } = await insertKey(db, { userId, name: o.name, pepper: o.pepper });
  return { id, key };
}
