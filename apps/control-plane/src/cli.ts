import { parseArgs } from 'node:util';
import pg from 'pg';
import { requireEnv } from './env.js';
import { createKey } from './keys.js';

const USAGE = 'usage: node dist/cli.js create-key --email <email> --name <name>';

function usageExit(msg: string): never {
  console.error(`${msg}\n${USAGE}`);
  process.exit(2);
}

let args: ReturnType<typeof parseArgs>;
try {
  args = parseArgs({
    allowPositionals: true,
    options: { email: { type: 'string' }, name: { type: 'string' } },
  });
} catch (err) {
  usageExit((err as Error).message);
}
const email = args.values.email;
const name = args.values.name;
if (args.positionals[0] !== 'create-key' || typeof email !== 'string' || typeof name !== 'string') {
  usageExit('bad arguments');
}

let env: Record<'DATABASE_URL' | 'API_KEY_PEPPER', string>;
try {
  env = requireEnv('DATABASE_URL', 'API_KEY_PEPPER');
} catch (err) {
  usageExit((err as Error).message);
}

const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 1 });
try {
  const { key } = await createKey(pool, { email, name, pepper: env.API_KEY_PEPPER });
  process.stdout.write(`${key}\n`);
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
