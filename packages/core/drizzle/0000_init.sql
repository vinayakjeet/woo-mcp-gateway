CREATE EXTENSION IF NOT EXISTS citext;--> statement-breakpoint
CREATE TYPE "public"."approval" AS ENUM('approved', 'pending');--> statement-breakpoint
CREATE TYPE "public"."auth_type" AS ENUM('none', 'bearer', 'header');--> statement-breakpoint
CREATE TYPE "public"."policy_effect" AS ENUM('allow', 'deny');--> statement-breakpoint
CREATE TYPE "public"."audit_outcome" AS ENUM('ok', 'tool_error', 'denied', 'timeout', 'unreachable', 'disabled', 'rate_limited', 'bad_request', 'upstream_error');--> statement-breakpoint
CREATE TYPE "public"."protocol_mode" AS ENUM('legacy', 'auto');--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('admin', 'member');--> statement-breakpoint
CREATE TYPE "public"."server_kind" AS ENUM('external', 'store', 'hosted', 'system');--> statement-breakpoint
CREATE TYPE "public"."server_state" AS ENUM('connected', 'unreachable', 'disabled', 'pending');--> statement-breakpoint
CREATE TYPE "public"."store_status" AS ENUM('provisioning', 'ready', 'failed', 'deleting');--> statement-breakpoint
CREATE TYPE "public"."tool_mode" AS ENUM('full', 'search', 'auto');--> statement-breakpoint
CREATE TYPE "public"."tool_state" AS ENUM('active', 'changed', 'removed');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('invited', 'active', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."audit_via" AS ENUM('api_key', 'agent', 'oauth');--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"prefix" char(8) NOT NULL,
	"secret_hash" text NOT NULL,
	"tool_mode" "tool_mode" DEFAULT 'auto' NOT NULL,
	"rate_limit_per_min" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	CONSTRAINT "api_keys_prefix_unique" UNIQUE("prefix")
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"request_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"user_email" text NOT NULL,
	"via" "audit_via" NOT NULL,
	"api_key_id" uuid,
	"server_id" uuid,
	"server_slug" text NOT NULL,
	"tool_name" text NOT NULL,
	"exposed_name" text NOT NULL,
	"meta_tool" text,
	"outcome" "audit_outcome" NOT NULL,
	"duration_ms" integer NOT NULL,
	"error_message" text,
	"args_sha256" text,
	"replica" text NOT NULL,
	"protocol_version" text
);
--> statement-breakpoint
CREATE TABLE "hosted_servers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"image" text NOT NULL,
	"port" integer NOT NULL,
	"path" text DEFAULT '/mcp' NOT NULL,
	"env" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secret_env_enc" "bytea",
	"cpu_limit" text NOT NULL,
	"memory_limit" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"status_reason" text,
	"server_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hosted_servers_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" "citext" NOT NULL,
	"role" "role" DEFAULT 'member' NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"created_by" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_server_status" (
	"server_id" uuid PRIMARY KEY NOT NULL,
	"state" "server_state" DEFAULT 'pending' NOT NULL,
	"last_ok_at" timestamp with time zone,
	"last_error_at" timestamp with time zone,
	"error_kind" text,
	"error_message" text,
	"tool_count" integer DEFAULT 0 NOT NULL,
	"checked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "mcp_servers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"kind" "server_kind" NOT NULL,
	"managed" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"auth_type" "auth_type" DEFAULT 'none' NOT NULL,
	"auth_header_name" text,
	"auth_secret_enc" "bytea",
	"timeout_ms" integer DEFAULT 15000 NOT NULL,
	"protocol_mode" "protocol_mode" DEFAULT 'legacy' NOT NULL,
	"approval" "approval" DEFAULT 'approved' NOT NULL,
	"store_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_servers_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "mcp_tools" (
	"server_id" uuid NOT NULL,
	"name" text NOT NULL,
	"exposed_name" text NOT NULL,
	"title" text,
	"description" text,
	"input_schema" jsonb NOT NULL,
	"annotations" jsonb,
	"definition_hash" text NOT NULL,
	"approved_hash" text,
	"state" "tool_state" DEFAULT 'active' NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_tools_server_id_name_pk" PRIMARY KEY("server_id","name")
);
--> statement-breakpoint
CREATE TABLE "oauth_clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" text NOT NULL,
	"name" text NOT NULL,
	"redirect_uris" jsonb NOT NULL,
	"metadata_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_clients_client_id_unique" UNIQUE("client_id")
);
--> statement-breakpoint
CREATE TABLE "oauth_codes" (
	"code_hash" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"redirect_uri" text NOT NULL,
	"code_challenge" text NOT NULL,
	"resource" text NOT NULL,
	"scope" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "oauth_consents" (
	"user_id" uuid NOT NULL,
	"client_id" text NOT NULL,
	"scope" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_consents_user_id_client_id_pk" PRIMARY KEY("user_id","client_id")
);
--> statement-breakpoint
CREATE TABLE "oauth_refresh_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"client_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"resource" text NOT NULL,
	"scope" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"replaced_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_refresh_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "platform_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_counters" (
	"subject" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "rate_counters_subject_window_start_pk" PRIMARY KEY("subject","window_start")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_agent" text,
	CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "stores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"status" "store_status" DEFAULT 'provisioning' NOT NULL,
	"status_reason" text,
	"last_step" text,
	"url" text,
	"namespace" text NOT NULL,
	"release" text NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"idempotency_key" text,
	"deadline_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ready_at" timestamp with time zone,
	CONSTRAINT "stores_slug_unique" UNIQUE("slug"),
	CONSTRAINT "stores_owner_idempotency_key" UNIQUE("owner_user_id","idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "tool_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"role" "role" NOT NULL,
	"server_pattern" text NOT NULL,
	"tool_pattern" text NOT NULL,
	"effect" "policy_effect" NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" "citext" NOT NULL,
	"name" text,
	"role" "role" DEFAULT 'member' NOT NULL,
	"password_hash" text,
	"status" "user_status" DEFAULT 'invited' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"invited_by" uuid,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosted_servers" ADD CONSTRAINT "hosted_servers_server_id_mcp_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."mcp_servers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_server_status" ADD CONSTRAINT "mcp_server_status_server_id_mcp_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."mcp_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_store_id_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."stores"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_tools" ADD CONSTRAINT "mcp_tools_server_id_mcp_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."mcp_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_codes" ADD CONSTRAINT "oauth_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_consents" ADD CONSTRAINT "oauth_consents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_refresh_tokens" ADD CONSTRAINT "oauth_refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stores" ADD CONSTRAINT "stores_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_ts_idx" ON "audit_events" USING btree ("ts" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_events_user_ts_idx" ON "audit_events" USING btree ("user_id","ts" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_events_server_ts_idx" ON "audit_events" USING btree ("server_slug","ts" DESC NULLS LAST);