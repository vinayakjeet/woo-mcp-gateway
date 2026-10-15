import { ago, formatTs } from './format';
import { KEY_TONE, keyStatus } from './keys';
import type { ApiKey } from './types';
import { Button, Pill, td, th } from './ui';

export function KeyTable({ keys, onRevoke }: { keys: ApiKey[]; onRevoke: (k: ApiKey) => void }) {
  if (keys.length === 0) return <p className="text-muted">No keys yet.</p>;
  const now = Date.now();
  return (
    <table className="w-full border-collapse rounded border border-line bg-panel">
      <thead>
        <tr>
          {['Name', 'Prefix', 'Mode', 'Created', 'Last used', 'Status', ''].map((h) => (
            <th key={h} className={th}>
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {keys.map((k) => {
          const status = keyStatus(k, now);
          return (
            <tr key={k.id}>
              <td className={td}>{k.name}</td>
              <td className={`${td} font-mono`}>urk_{k.prefix}</td>
              <td className={td}>{k.toolMode}</td>
              <td className={td}>{formatTs(k.createdAt)}</td>
              <td className={td}>{k.lastUsedAt ? ago(k.lastUsedAt, now) : 'never'}</td>
              <td className={td}>
                <Pill tone={KEY_TONE[status]}>{status}</Pill>
              </td>
              <td className={`${td} text-right`}>
                {status === 'active' && (
                  <Button tone="danger" onClick={() => onRevoke(k)}>
                    Revoke
                  </Button>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
