ALTER TABLE "mcp_servers" ADD COLUMN "tools_synced_at" timestamp with time zone;
--> statement-breakpoint
-- A server with any mcp_tools row, removed ones included, has synced before. A server without
-- rows stays null, so its next list, even an empty one, is recorded as its first sync.
UPDATE "mcp_servers" s
SET "tools_synced_at" = now()
WHERE EXISTS (SELECT 1 FROM "mcp_tools" t WHERE t."server_id" = s."id");
