import { useState } from 'react';
import { ago, formatTs } from './format';
import { KEY_TONE, keyStatus, parseLimit } from './keys';
import type { ApiKey } from './types';
import { Button, Input, Pill, td, th } from './ui';

function LimitCell({
  k,
  onSetLimit,
}: {
  k: ApiKey;
  // Present only for admins, and not for a key that can no longer be changed.
  onSetLimit?: (k: ApiKey, limit: number | null) => void;
}) {
  const [text, setText] = useState<string | null>(null);
  if (text === null) {
    return (
      <>
        {k.rateLimitPerMin ?? <span className="text-muted">default</span>}
        {onSetLimit && (
          <>
            {' '}
            <Button
              aria-label="Edit limit"
              onClick={() => setText(k.rateLimitPerMin === null ? '' : String(k.rateLimitPerMin))}
            >
              Edit
            </Button>
          </>
        )}
      </>
    );
  }
  const value = parseLimit(text);
  const done = (limit: number | null) => {
    onSetLimit?.(k, limit);
    setText(null);
  };
  return (
    <form
      className="flex items-center gap-1"
      onSubmit={(e) => {
        e.preventDefault();
        if (value !== null) done(value);
      }}
    >
      <Input
        inputMode="numeric"
        className="w-20"
        value={text}
        placeholder="1 to 10000"
        aria-label={`Limit per minute for ${k.name}`}
        onChange={(e) => setText(e.target.value)}
      />
      <Button type="submit" tone="primary" disabled={value === null} aria-label="Save limit">
        Save
      </Button>
      <Button onClick={() => done(null)}>Use default</Button>
      <Button onClick={() => setText(null)}>Cancel</Button>
    </form>
  );
}

export function KeyTable({
  keys,
  onRevoke,
  onSetLimit,
}: {
  keys: ApiKey[];
  onRevoke: (k: ApiKey) => void;
  onSetLimit?: (k: ApiKey, limit: number | null) => void;
}) {
  if (keys.length === 0) return <p className="text-muted">No keys yet.</p>;
  const now = Date.now();
  return (
    <table className="w-full border-collapse rounded border border-line bg-panel">
      <thead>
        <tr>
          {['Name', 'Prefix', 'Mode', 'Limit/min', 'Created', 'Last used', 'Status', ''].map(
            (h) => (
              <th key={h} className={th}>
                {h}
              </th>
            ),
          )}
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
              <td className={td}>
                <LimitCell k={k} onSetLimit={status === 'active' ? onSetLimit : undefined} />
              </td>
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
