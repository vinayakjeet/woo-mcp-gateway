import {
  bigserial,
  boolean,
  char,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

const citext = customType<{ data: string }>({ dataType: () => 'citext' });
const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' });
const ts = (name: string) => timestamp(name, { withTimezone: true });

export const roleEnum = pgEnum('role', ['admin', 'member']);
export const userStatusEnum = pgEnum('user_status', ['invited', 'active', 'disabled']);
export const toolModeEnum = pgEnum('tool_mode', ['full', 'search', 'auto']);
export const serverKindEnum = pgEnum('server_kind', ['external', 'store', 'hosted', 'system']);
export const authTypeEnum = pgEnum('auth_type', ['none', 'bearer', 'header']);
export const protocolModeEnum = pgEnum('protocol_mode', ['legacy', 'auto']);
export const approvalEnum = pgEnum('approval', ['approved', 'pending']);
export const serverStateEnum = pgEnum('server_state', [
  'connected',
  'unreachable',
  'disabled',
  'pending',
]);
export const toolStateEnum = pgEnum('tool_state', ['active', 'changed', 'removed']);
export const effectEnum = pgEnum('policy_effect', ['allow', 'deny']);
export const viaEnum = pgEnum('audit_via', ['api_key', 'agent', 'oauth']);
export const outcomeEnum = pgEnum('audit_outcome', [
  'ok',
  'tool_error',
  'denied',
  'timeout',
  'unreachable',
  'disabled',
  'rate_limited',
  'bad_request',
  'upstream_error',
]);
export const storeStatusEnum = pgEnum('store_status', [
  'provisioning',
  'ready',
  'failed',
  'deleting',
]);

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: citext('email').notNull().unique(),
  name: text('name'),
  role: roleEnum('role').notNull().default('member'),
  passwordHash: text('password_hash'),
  status: userStatusEnum('status').notNull().default('invited'),
  createdAt: ts('created_at').notNull().defaultNow(),
  invitedBy: uuid('invited_by'),
});

export const invites = pgTable('invites', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: citext('email').notNull(),
  role: roleEnum('role').notNull().default('member'),
  tokenHash: text('token_hash').notNull(),
  expiresAt: ts('expires_at').notNull(),
  acceptedAt: ts('accepted_at'),
  createdBy: uuid('created_by')
    .notNull()
    .references(() => users.id),
});

export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  createdAt: ts('created_at').notNull().defaultNow(),
  expiresAt: ts('expires_at').notNull(),
  lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
  userAgent: text('user_agent'),
});

export const apiKeys = pgTable('api_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  prefix: char('prefix', { length: 8 }).notNull().unique(),
  secretHash: text('secret_hash').notNull(),
  toolMode: toolModeEnum('tool_mode').notNull().default('auto'),
  rateLimitPerMin: integer('rate_limit_per_min'),
  createdAt: ts('created_at').notNull().defaultNow(),
  lastUsedAt: ts('last_used_at'),
  revokedAt: ts('revoked_at'),
  expiresAt: ts('expires_at'),
});

export const stores = pgTable(
  'stores',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull().unique(),
    name: text('name').notNull(),
    ownerUserId: uuid('owner_user_id')
      .notNull()
      .references(() => users.id),
    status: storeStatusEnum('status').notNull().default('provisioning'),
    statusReason: text('status_reason'),
    lastStep: text('last_step'),
    url: text('url'),
    namespace: text('namespace').notNull(),
    release: text('release').notNull(),
    attempt: integer('attempt').notNull().default(0),
    idempotencyKey: text('idempotency_key'),
    deadlineAt: ts('deadline_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    readyAt: ts('ready_at'),
  },
  (t) => [unique('stores_owner_idempotency_key').on(t.ownerUserId, t.idempotencyKey)],
);

export const mcpServers = pgTable('mcp_servers', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  url: text('url').notNull(),
  kind: serverKindEnum('kind').notNull(),
  managed: boolean('managed').notNull().default(false),
  enabled: boolean('enabled').notNull().default(true),
  authType: authTypeEnum('auth_type').notNull().default('none'),
  authHeaderName: text('auth_header_name'),
  authSecretEnc: bytea('auth_secret_enc'),
  timeoutMs: integer('timeout_ms').notNull().default(15000),
  protocolMode: protocolModeEnum('protocol_mode').notNull().default('legacy'),
  approval: approvalEnum('approval').notNull().default('approved'),
  storeId: uuid('store_id').references(() => stores.id, { onDelete: 'set null' }),
  // Set by the first tool sync, even an empty one: a hosted server is auto-approved only then.
  toolsSyncedAt: ts('tools_synced_at'),
  createdBy: uuid('created_by'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const mcpServerStatus = pgTable('mcp_server_status', {
  serverId: uuid('server_id')
    .primaryKey()
    .references(() => mcpServers.id, { onDelete: 'cascade' }),
  state: serverStateEnum('state').notNull().default('pending'),
  lastOkAt: ts('last_ok_at'),
  lastErrorAt: ts('last_error_at'),
  errorKind: text('error_kind'),
  errorMessage: text('error_message'),
  toolCount: integer('tool_count').notNull().default(0),
  checkedAt: ts('checked_at'),
});

export const mcpTools = pgTable(
  'mcp_tools',
  {
    serverId: uuid('server_id')
      .notNull()
      .references(() => mcpServers.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    exposedName: text('exposed_name').notNull(),
    title: text('title'),
    description: text('description'),
    inputSchema: jsonb('input_schema').notNull(),
    annotations: jsonb('annotations'),
    definitionHash: text('definition_hash').notNull(),
    approvedHash: text('approved_hash'),
    approvedDefinition: jsonb('approved_definition'),
    state: toolStateEnum('state').notNull().default('active'),
    firstSeenAt: ts('first_seen_at').notNull().defaultNow(),
    lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.serverId, t.name] })],
);

export const toolPolicies = pgTable('tool_policies', {
  id: uuid('id').primaryKey().defaultRandom(),
  role: roleEnum('role').notNull(),
  serverPattern: text('server_pattern').notNull(),
  toolPattern: text('tool_pattern').notNull(),
  effect: effectEnum('effect').notNull(),
  priority: integer('priority').notNull().default(0),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const auditEvents = pgTable(
  'audit_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    ts: ts('ts').notNull().defaultNow(),
    requestId: uuid('request_id').notNull(),
    userId: uuid('user_id').notNull(),
    userEmail: text('user_email').notNull(),
    via: viaEnum('via').notNull(),
    apiKeyId: uuid('api_key_id'),
    serverId: uuid('server_id'),
    serverSlug: text('server_slug').notNull(),
    toolName: text('tool_name').notNull(),
    exposedName: text('exposed_name').notNull(),
    metaTool: text('meta_tool'),
    outcome: outcomeEnum('outcome').notNull(),
    durationMs: integer('duration_ms').notNull(),
    errorMessage: text('error_message'),
    argsSha256: text('args_sha256'),
    replica: text('replica').notNull(),
    protocolVersion: text('protocol_version'),
  },
  (t) => [
    index('audit_events_ts_idx').on(t.ts.desc()),
    index('audit_events_user_ts_idx').on(t.userId, t.ts.desc()),
    index('audit_events_server_ts_idx').on(t.serverSlug, t.ts.desc()),
  ],
);

export const hostedServers = pgTable('hosted_servers', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  image: text('image').notNull(),
  port: integer('port').notNull(),
  path: text('path').notNull().default('/mcp'),
  env: jsonb('env').notNull().default({}),
  secretEnvEnc: bytea('secret_env_enc'),
  cpuLimit: text('cpu_limit').notNull(),
  memoryLimit: text('memory_limit').notNull(),
  status: text('status').notNull().default('pending'),
  statusReason: text('status_reason'),
  serverId: uuid('server_id').references(() => mcpServers.id, { onDelete: 'set null' }),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const rateCounters = pgTable(
  'rate_counters',
  {
    subject: text('subject').notNull(),
    windowStart: ts('window_start').notNull(),
    count: integer('count').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.subject, t.windowStart] })],
);

// SPEC 24 lists no columns; M13 only adds to these.
export const oauthClients = pgTable('oauth_clients', {
  id: uuid('id').primaryKey().defaultRandom(),
  clientId: text('client_id').notNull().unique(),
  name: text('name').notNull(),
  redirectUris: jsonb('redirect_uris').notNull(),
  metadataUrl: text('metadata_url'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const oauthCodes = pgTable('oauth_codes', {
  codeHash: text('code_hash').primaryKey(),
  clientId: text('client_id').notNull(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  redirectUri: text('redirect_uri').notNull(),
  codeChallenge: text('code_challenge').notNull(),
  resource: text('resource').notNull(),
  scope: text('scope').notNull(),
  expiresAt: ts('expires_at').notNull(),
  usedAt: ts('used_at'),
});

export const oauthConsents = pgTable(
  'oauth_consents',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    clientId: text('client_id').notNull(),
    scope: text('scope').notNull(),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.clientId] })],
);

export const oauthRefreshTokens = pgTable('oauth_refresh_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  tokenHash: text('token_hash').notNull().unique(),
  clientId: text('client_id').notNull(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  resource: text('resource').notNull(),
  scope: text('scope').notNull(),
  expiresAt: ts('expires_at').notNull(),
  revokedAt: ts('revoked_at'),
  replacedBy: uuid('replaced_by'),
  createdAt: ts('created_at').notNull().defaultNow(),
});

export const platformSettings = pgTable('platform_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
});
