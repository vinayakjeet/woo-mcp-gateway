export const SNIPPET_TABS = [
  { id: 'claudeCode', label: 'Claude Code' },
  { id: 'cursor', label: 'Cursor' },
  { id: 'inspector', label: 'MCP Inspector' },
] as const;
export type SnippetId = (typeof SNIPPET_TABS)[number]['id'];

export function snippets(gatewayUrl: string, key: string): Record<SnippetId, string> {
  return {
    claudeCode: `claude mcp add --transport http urumi ${gatewayUrl} --header "Authorization: Bearer ${key}"`,
    cursor: JSON.stringify(
      { mcpServers: { urumi: { url: gatewayUrl, headers: { Authorization: `Bearer ${key}` } } } },
      null,
      2,
    ),
    inspector: [
      'Transport Type: Streamable HTTP',
      `URL: ${gatewayUrl}`,
      'Header name: Authorization',
      `Header value: Bearer ${key}`,
    ].join('\n'),
  };
}
