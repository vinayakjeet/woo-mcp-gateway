import { schemaReady } from '@woo/core/db';
import pg from 'pg';
import { buildHealthApp } from './health.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error(JSON.stringify({ level: 'error', msg: 'Missing env vars: DATABASE_URL' }));
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const app = buildHealthApp({ ready: () => schemaReady(pool) }, { level: 'info' });

await app.listen({ host: '0.0.0.0', port: Number(process.env.HEALTH_PORT ?? 9090) });

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    void app
      .close()
      .then(() => pool.end())
      .finally(() => process.exit(0));
  });
}
