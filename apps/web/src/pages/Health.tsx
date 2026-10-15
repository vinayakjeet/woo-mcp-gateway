import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { ago } from '../format';
import {
  formatMs,
  formatPerMinute,
  formatRate,
  HEALTH_REFRESH_MS,
  HEALTH_WINDOW,
  healthPill,
} from '../health';
import type { HealthResponse } from '../types';
import { ErrorLine, PageHeader, Pill, td, th } from '../ui';

export function HealthPage() {
  const health = useQuery({
    queryKey: ['health', HEALTH_WINDOW],
    queryFn: () => api<HealthResponse>(`/api/stats/servers?window=${HEALTH_WINDOW}`),
    refetchInterval: HEALTH_REFRESH_MS,
  });
  return (
    <>
      <PageHeader title="Health">
        <span className="text-xs text-muted">Last 60 minutes, refreshes every 10 s</span>
      </PageHeader>
      <ErrorLine error={health.error} />
      <table className="w-full border-collapse rounded border border-line bg-panel">
        <thead>
          <tr>
            {[
              'Status',
              'Server',
              'Calls/min',
              'Error rate',
              'p50',
              'p95',
              'Last error',
              'Checked',
            ].map((h) => (
              <th key={h} className={th}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {health.data?.servers.map((s) => {
            const pill = healthPill(s);
            return (
              <tr key={s.slug}>
                <td className={td}>
                  <Pill tone={pill.tone}>{pill.label}</Pill>
                </td>
                <td className={`${td} font-mono`}>{s.slug}</td>
                <td className={td}>{formatPerMinute(s.callsPerMinute)}</td>
                <td className={td}>{formatRate(s.errorRate)}</td>
                <td className={td}>{formatMs(s.p50Ms)}</td>
                <td className={td}>{formatMs(s.p95Ms)}</td>
                <td className={`${td} max-w-xs truncate`} title={s.errorMessage ?? ''}>
                  {s.errorKind ? `${s.errorKind}: ${s.errorMessage ?? ''}` : '-'}
                </td>
                <td className={td}>{s.checkedAt ? ago(s.checkedAt) : 'never'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}
