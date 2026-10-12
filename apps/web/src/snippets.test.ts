import { describe, expect, it } from 'vitest';
import { SNIPPET_TABS, snippets } from './snippets';

const URL = 'http://mcp.127.0.0.1.nip.io/mcp';
const KEY = `urk_abcd1234_${'x'.repeat(43)}`;

describe('snippets', () => {
  it('matches the SPEC 14 Claude Code command', () => {
    expect(snippets(URL, KEY).claudeCode).toBe(
      `claude mcp add --transport http urumi http://mcp.127.0.0.1.nip.io/mcp --header "Authorization: Bearer ${KEY}"`,
    );
  });
  it('gives Cursor a valid mcp.json block', () => {
    expect(JSON.parse(snippets(URL, KEY).cursor)).toEqual({
      mcpServers: { urumi: { url: URL, headers: { Authorization: `Bearer ${KEY}` } } },
    });
  });
  it('names the Inspector transport, URL and header', () => {
    const s = snippets(URL, KEY).inspector;
    expect(s).toContain('Streamable HTTP');
    expect(s).toContain(URL);
    expect(s).toContain(`Bearer ${KEY}`);
  });
  it('has one tab per snippet', () => {
    expect(SNIPPET_TABS.map((t) => t.id).sort()).toEqual(Object.keys(snippets(URL, KEY)).sort());
  });
});
