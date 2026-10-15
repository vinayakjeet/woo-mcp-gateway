import { MetricsRegistry } from '@woo/core';

const STORE_STATUSES = ['provisioning', 'ready', 'failed', 'deleting'] as const;
// A store takes about two minutes to install on k3d; the top bucket is the 15 minute deadline.
const DURATION_BUCKETS = [30, 60, 90, 120, 180, 300, 600, 900];

type Queryable = { query(sql: string): Promise<{ rows: Array<{ status: string; n: string }> }> };

export function createProvisionerMetrics(db: Queryable) {
  const reg = new MetricsRegistry();
  let counts: Map<string, number> | null = null;
  reg.gauge('provisioner_stores', 'Stores by status.', ['status'], () =>
    counts
      ? STORE_STATUSES.map((s) => ({ labels: { status: s }, value: counts?.get(s) ?? 0 }))
      : [],
  );
  const duration = reg.histogram(
    'provisioner_duration_seconds',
    'Seconds from store creation to ready. Starts again at zero when the control-plane restarts.',
    [],
    DURATION_BUCKETS,
  );
  return {
    storeReady: (seconds: number) => duration.observe({}, seconds),
    // The gauge reads a snapshot taken just before it renders. When the query fails the store rows
    // are left out (absent, not stale), and the error text is never exposed.
    async render(): Promise<string> {
      try {
        const r = await db.query(
          'select status::text as status, count(*)::text as n from stores group by status',
        );
        counts = new Map(r.rows.map((row) => [row.status, Number(row.n)]));
      } catch {
        counts = null;
      }
      return reg.render();
    },
  };
}

export type ProvisionerMetrics = ReturnType<typeof createProvisionerMetrics>;
