import type { Server, Tone } from './types';

export type Pill = {
  label: 'Connected' | 'Unreachable' | 'Disabled' | 'Pending approval' | 'Checking';
  tone: Tone;
};

// enabled and approval come from mcp_servers and win; state comes from the gateway's last check
// in mcp_server_status, which lags a change by up to a second.
export function serverPill(s: Pick<Server, 'enabled' | 'approval' | 'status'>): Pill {
  if (!s.enabled) return { label: 'Disabled', tone: 'off' };
  if (s.approval === 'pending') return { label: 'Pending approval', tone: 'warn' };
  if (s.status?.state === 'connected') return { label: 'Connected', tone: 'ok' };
  if (s.status?.state === 'unreachable') return { label: 'Unreachable', tone: 'bad' };
  return { label: 'Checking', tone: 'idle' };
}

export type ServerFormState = {
  name: string;
  slug: string;
  url: string;
  authType: 'none' | 'bearer' | 'header';
  headerName: string;
  secret: string;
  timeoutMs: number;
  protocolMode: 'legacy' | 'auto';
};

export function formFromServer(s: Server | null): ServerFormState {
  if (!s) {
    return {
      name: '',
      slug: '',
      url: '',
      authType: 'none',
      headerName: '',
      secret: '',
      timeoutMs: 15000,
      protocolMode: 'legacy',
    };
  }
  return {
    name: s.name,
    slug: s.slug,
    url: s.url,
    authType: s.auth.type,
    headerName: s.auth.headerName ?? '',
    secret: '',
    timeoutMs: s.timeoutMs,
    protocolMode: s.protocolMode,
  };
}

function authBody(f: ServerFormState) {
  if (f.authType === 'none') return { type: 'none' as const };
  const secret = f.secret ? { secret: f.secret } : {};
  return f.authType === 'header'
    ? { type: 'header' as const, headerName: f.headerName.trim(), ...secret }
    : { type: 'bearer' as const, ...secret };
}

export function serverCreate(f: ServerFormState) {
  return {
    name: f.name.trim(),
    slug: f.slug.trim(),
    url: f.url.trim(),
    auth: authBody(f),
    timeoutMs: f.timeoutMs,
    protocolMode: f.protocolMode,
  };
}

// Only changed fields go out. The secret goes out only when typed, so saving an edit never
// clears it by accident.
export function serverPatch(f: ServerFormState, s: Server): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (f.timeoutMs !== s.timeoutMs) out.timeoutMs = f.timeoutMs;
  if (s.managed) return out;
  if (f.name.trim() !== s.name) out.name = f.name.trim();
  if (f.url.trim() !== s.url) out.url = f.url.trim();
  if (f.protocolMode !== s.protocolMode) out.protocolMode = f.protocolMode;
  const headerChanged =
    f.authType === 'header' && f.headerName.trim() !== (s.auth.headerName ?? '');
  if (f.authType !== s.auth.type || f.secret !== '' || headerChanged) out.auth = authBody(f);
  return out;
}
