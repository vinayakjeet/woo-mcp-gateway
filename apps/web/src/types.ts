export type Role = 'admin' | 'member';
export type Tone = 'ok' | 'bad' | 'warn' | 'off' | 'idle';
export type Me = { id: string; email: string; name: string | null; role: Role };
export type Config = { gatewayUrl: string; version: string };
export type ToolMode = 'auto' | 'search' | 'full';
export type ApiKey = {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  expiresAt: string | null;
  toolMode: ToolMode;
  // Calls per minute for this key. Null means the gateway default.
  rateLimitPerMin: number | null;
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
  // An upstream hint, shown only. Policy never reads it.
  readOnly: boolean;
  state: 'active' | 'changed';
  // The roles whose policy rules allow this tool, computed by the API with the gateway's evaluator.
  roles: Role[];
};
export type Policy = {
  id: string;
  role: Role;
  serverPattern: string;
  toolPattern: string;
  effect: 'allow' | 'deny';
  priority: number;
  createdAt: string;
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

export type HostedStatus = 'pending' | 'ready' | 'failed' | 'deleting';
export type HostedServer = {
  id: string;
  slug: string;
  image: string;
  port: number;
  path: string;
  env: Array<{ name: string; value: string }>;
  // Names only: the API never sends a secret value back.
  secretEnvNames: string[];
  cpu: string;
  memory: string;
  status: HostedStatus;
  reason: string | null;
  serverId: string | null;
  url: string;
  createdAt: string;
};
export type HostedLimits = { allowedImagePrefixes: string[]; maxCpu: string; maxMemory: string };
export type HostedResponse = { servers: HostedServer[]; limits: HostedLimits };

export type ScreenFlag = {
  kind: 'hidden_unicode' | 'long_description' | 'suspicious_phrase';
  detail: string;
};
export type ApprovalTool = {
  name: string;
  exposedName: string;
  state: 'active' | 'changed';
  title: string | null;
  definitionHash: string;
  approvedHash: string | null;
  current: { description: string | null; inputSchema: unknown; annotations: unknown };
  approved: { description: string | null; inputSchema: unknown; annotations: unknown } | null;
  flags: ScreenFlag[];
};
export type ApprovalServer = {
  id: string;
  slug: string;
  name: string;
  url: string;
  kind: 'external';
  approval: 'approved' | 'pending';
  tools: ApprovalTool[];
};
export type ApproveResult = { approved: string[]; stale: string[] };

export type ServerHealth = {
  slug: string;
  name: string;
  kind: Server['kind'];
  enabled: boolean;
  approval: 'approved' | 'pending';
  state: ServerState | null;
  errorKind: string | null;
  errorMessage: string | null;
  checkedAt: string | null;
  calls: number;
  callsPerMinute: number;
  outcomes: Record<string, number>;
  errorRate: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
};
export type HealthResponse = { windowMinutes: number; servers: ServerHealth[] };
