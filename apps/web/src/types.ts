export type Role = 'admin' | 'member';
export type Tone = 'ok' | 'bad' | 'warn' | 'off' | 'idle';
export type Me = { id: string; email: string; name: string | null; role: Role };
export type Config = { gatewayUrl: string; version: string };
export type ApiKey = {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  expiresAt: string | null;
};
export type Member = {
  id: string;
  email: string;
  name: string | null;
  role: Role;
  status: 'invited' | 'active' | 'disabled';
  createdAt: string;
  activeKeys: number;
};
export type ServerState = 'connected' | 'unreachable' | 'disabled' | 'pending';
export type Tool = {
  exposedName: string;
  title: string | null;
  description: string | null;
  readOnly: boolean;
};
export type Server = {
  id: string;
  slug: string;
  name: string;
  url: string;
  kind: 'external' | 'store' | 'hosted' | 'system';
  managed: boolean;
  enabled: boolean;
  approval: 'approved' | 'pending';
  protocolMode: 'legacy' | 'auto';
  timeoutMs: number;
  auth: { type: 'none' | 'bearer' | 'header'; headerName: string | null; hasSecret: boolean };
  status: {
    state: ServerState;
    toolCount: number;
    errorKind: string | null;
    errorMessage: string | null;
    checkedAt: string | null;
    lastOkAt: string | null;
  } | null;
  tools: Tool[];
};
export type AuditItem = {
  id: string;
  ts: string;
  userId: string;
  userEmail: string;
  via: string;
  serverSlug: string;
  toolName: string;
  exposedName: string;
  outcome: string;
  durationMs: number;
  errorMessage: string | null;
  replica: string;
};
export type AuditResponse = { items: AuditItem[]; nextCursor: string | null };

export type StoreStatus = 'provisioning' | 'ready' | 'failed' | 'deleting';
export type Store = {
  id: string;
  slug: string;
  name: string;
  status: StoreStatus;
  statusReason: string | null;
  lastStep: string | null;
  url: string | null;
  attempt: number;
  createdAt: string;
  readyAt: string | null;
  deadlineAt: string | null;
  owner: { id: string; email: string };
  deletable: boolean;
  seeded: boolean;
};
