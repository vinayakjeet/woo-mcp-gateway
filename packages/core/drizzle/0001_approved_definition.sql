ALTER TABLE "mcp_tools" ADD COLUMN "approved_definition" jsonb;
--> statement-breakpoint
-- Tools already shown to members were approved in effect. Tools that are changed, removed or
-- belong to a pending server were never reviewed, so they keep a null approved_hash.
UPDATE "mcp_tools" t
SET "approved_hash" = t."definition_hash",
    "approved_definition" = jsonb_build_object(
      'name', t."name",
      'description', t."description",
      'inputSchema', t."input_schema",
      'annotations', t."annotations")
FROM "mcp_servers" s
WHERE s."id" = t."server_id" AND s."approval" = 'approved' AND t."state" = 'active';
