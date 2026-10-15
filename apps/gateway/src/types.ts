import type { CallToolResult } from '@modelcontextprotocol/client';
import type { ServerKind } from '@woo/core';
import type { outcomeEnum, schema } from '@woo/core/db';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

export type Db = NodePgDatabase<typeof schema>;

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ErrorKind =
  | 'dns'
  | 'refused'
  | 'timeout'
  | 'tls'
  | 'blocked'
  | 'http_401'
  | 'http_403'
  | 'http_404'
  | 'http_5xx'
  | 'protocol'
  | 'unknown';

export type Failure = { kind: ErrorKind; message: string };

export type UpstreamAuth =
  | { type: 'none' }
  | { type: 'bearer'; secret: string }
  | { type: 'header'; headerName: string; secret: string };

// Holds a decrypted credential: never log a whole record.
export type ServerRecord = {
  id: string;
  slug: string;
  name: string;
  url: string;
  kind: ServerKind;
  enabled: boolean;
  approval: 'approved' | 'pending';
  timeoutMs: number;
  protocolMode: 'legacy' | 'auto';
  auth: UpstreamAuth;
  credentialError?: true;
};

export type ToolState = 'active' | 'changed' | 'removed';
export type PersistedTool = {
  name: string;
  exposedName: string;
  state: ToolState;
  definitionHash: string;
};

export type ToolMode = 'full' | 'search' | 'auto';

export type Principal = {
  userId: string;
  email: string;
  role: 'admin' | 'member';
  via: 'api_key' | 'agent';
  apiKeyId: string | null;
  toolMode: ToolMode;
  // The key's own limit per minute. Null means the gateway default (always null for the agent).
  rateLimitPerMin: number | null;
};

export type Outcome = (typeof outcomeEnum.enumValues)[number];

export type AuditRow = {
  requestId: string;
  userId: string;
  userEmail: string;
  via: Principal['via'];
  apiKeyId: string | null;
  serverId: string | null;
  serverSlug: string;
  toolName: string;
  exposedName: string;
  metaTool: 'search_tools' | 'call_tool' | null;
  outcome: Outcome;
  durationMs: number;
  errorMessage: string | null;
  argsSha256: string | null;
  replica: string;
  protocolVersion: string | null;
};

export interface AuditSink {
  write(row: AuditRow): Promise<void>;
}

// The pino shape Fastify's logger already has.
export type Log = {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
};

export type CallOutcome =
  | { outcome: 'ok' | 'tool_error'; result: CallToolResult }
  | { outcome: 'timeout' | 'unreachable' | 'upstream_error'; message: string };
