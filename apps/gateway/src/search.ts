import type { Tool } from '@modelcontextprotocol/client';
import MiniSearch from 'minisearch';
import { z } from 'zod';

// SPEC 17: above this many visible tools, `auto` lists only the two meta-tools.
export const SEARCH_THRESHOLD = 40;

export type ToolMode = 'full' | 'search' | 'auto';

export function parseToolModeOverride(raw: unknown): 'search' | 'full' | undefined {
  if (raw === undefined) return undefined;
  if (raw === 'search' || raw === 'full') return raw;
  throw new Error('Invalid toolMode');
}

export function effectiveToolMode(
  mode: ToolMode,
  visibleCount: number,
  override?: 'search' | 'full',
): 'full' | 'search' {
  const chosen = override ?? mode;
  if (chosen !== 'auto') return chosen;
  return visibleCount > SEARCH_THRESHOLD ? 'search' : 'full';
}

export const DEFAULT_SEARCH_LIMIT = 5;
export const MAX_SEARCH_LIMIT = 10;
export const MAX_QUERY_LENGTH = 200;

export const searchToolsInput = z.object({
  query: z.string().min(1).max(MAX_QUERY_LENGTH),
  limit: z.number().int().min(1).max(MAX_SEARCH_LIMIT).default(DEFAULT_SEARCH_LIMIT),
});

export const callToolInput = z.object({
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()).optional(),
});

export const SEARCH_TOOLS = 'search_tools';
export const CALL_TOOL = 'call_tool';

const inputSchema = (schema: z.ZodType): Tool['inputSchema'] => {
  const json: Record<string, unknown> = z.toJSONSchema(schema, { io: 'input' });
  delete json.$schema;
  return json as Tool['inputSchema'];
};

// Sorted by name, like the full list. Exposed names always contain `__`, so these cannot collide.
export const META_TOOLS: Tool[] = [
  {
    name: CALL_TOOL,
    description:
      'Run a tool found with search_tools. Pass its exact name (for example "fx__convert_currency") and its arguments object.',
    inputSchema: inputSchema(callToolInput),
    annotations: { openWorldHint: true },
  },
  {
    name: SEARCH_TOOLS,
    description:
      'Search the available tools by keyword. Call this first: it returns the matching tools with their names, descriptions and input schemas. Then run one with call_tool.',
    inputSchema: inputSchema(searchToolsInput),
    annotations: { readOnlyHint: true },
  },
];

type Doc = { name: string; description: string; params: string };

const paramText = (schema: Tool['inputSchema']): string => {
  const props = (schema.properties ?? {}) as Record<string, { description?: unknown }>;
  return Object.entries(props)
    .map(([k, v]) => (typeof v?.description === 'string' ? `${k} ${v.description}` : k))
    .join(' ');
};

// Built per request: the visible list differs per principal and policy, and 500 tools index in
// well under the 50 ms the unit test allows.
export function searchTools(tools: Tool[], query: string, limit = DEFAULT_SEARCH_LIMIT): Tool[] {
  const index = new MiniSearch<Doc>({
    idField: 'name',
    fields: ['name', 'description', 'params'],
    storeFields: [],
    searchOptions: { boost: { name: 2 }, prefix: true, fuzzy: 0.2 },
  });
  index.addAll(
    tools.map((t) => ({
      name: t.name,
      description: t.description ?? '',
      params: paramText(t.inputSchema),
    })),
  );
  const byName = new Map(tools.map((t) => [t.name, t]));
  return index
    .search(query)
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, limit)
    .flatMap((r) => byName.get(r.id as string) ?? []);
}
