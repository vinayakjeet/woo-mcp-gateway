import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';
import { ago, formatTs } from './format';
import { useConfig } from './session';
import type { OAuthGrant } from './types';
import { Button, ErrorLine, td, th } from './ui';

export function ConnectedApps() {
  const config = useConfig();
  const enabled = config.data?.oauthEnabled === true;
  const qc = useQueryClient();
  const grants = useQuery({
    queryKey: ['oauth-grants'],
    queryFn: () => api<{ grants: OAuthGrant[] }>('/api/oauth/grants').then((r) => r.grants),
    enabled,
  });
  const revoke = useMutation({
    // A CIMD client id is an https URL, so it goes into the path encoded.
    mutationFn: (g: OAuthGrant) =>
      api(`/api/oauth/grants/${encodeURIComponent(g.clientId)}`, { method: 'DELETE' }),
    onSettled: () => void qc.invalidateQueries({ queryKey: ['oauth-grants'] }),
  });
  if (!enabled) return null;
  const now = Date.now();
  const rows = grants.data ?? [];
  return (
    <section className="mt-6">
      <h2 className="mb-1 text-sm font-medium">Connected apps</h2>
      <p className="mb-2 text-xs text-muted">
        Apps you approved without a key. Revoke ends the app&apos;s access on its next call.
      </p>
      <ErrorLine error={grants.error ?? revoke.error} />
      {rows.length === 0 && grants.isSuccess ? (
        <p className="text-muted">No apps connected.</p>
      ) : (
        rows.length > 0 && (
          <table
            aria-label="Connected apps"
            className="w-full border-collapse rounded border border-line bg-panel"
          >
            <thead>
              <tr>
                {['App', 'Source', 'Connected', 'Last refreshed', ''].map((h) => (
                  <th key={h} className={th}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((g) => (
                <tr key={g.clientId}>
                  <td className={td}>{g.name}</td>
                  <td className={td}>
                    {g.kind === 'cimd' ? g.host : <span className="text-muted">unverified</span>}
                  </td>
                  <td className={td}>{formatTs(g.approvedAt)}</td>
                  <td className={td}>
                    {g.lastRefreshedAt ? ago(g.lastRefreshedAt, now) : 'never'}
                  </td>
                  <td className={`${td} text-right`}>
                    <Button
                      tone="danger"
                      disabled={revoke.isPending}
                      onClick={() =>
                        window.confirm(
                          `Revoke "${g.name}"? It loses access on its next call and must be approved again.`,
                        ) && revoke.mutate(g)
                      }
                    >
                      Revoke
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      )}
    </section>
  );
}
