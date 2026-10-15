import type { Tool } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import {
  META_TOOLS,
  SEARCH_THRESHOLD,
  callToolInput,
  effectiveToolMode,
  parseToolModeOverride,
  searchTools,
  searchToolsInput,
} from './search.js';

const obj = (props: Record<string, Record<string, string>> = {}): Tool['inputSchema'] => ({
  type: 'object',
  properties: props,
});
const str = (description?: string) => ({ type: 'string', ...(description ? { description } : {}) });
const tool = (
  name: string,
  description: string,
  props: Record<string, Record<string, string>> = {},
): Tool => ({
  name,
  description,
  inputSchema: obj(props),
});

const ORDER_STATUS = str('Order status such as processing or completed');
const live: Tool[] = [
  tool('fx__get_info', '[fx] Rate provider, supported base currencies and cache age in seconds.'),
  tool(
    'fx__convert_currency',
    "[fx] Convert an amount between currencies at the latest or a given date's reference rate.",
    { amount: { type: 'number' }, from: str(), to: str(), date: str() },
  ),
  tool('fx__get_rates', '[fx] Latest reference rates for a base currency.', {
    base: str(),
    symbols: { type: 'array' },
  }),
  tool(
    'main__get_info',
    '[main] Store name, URL, currency, timezone and the number of orders placed today.',
  ),
  tool(
    'main__list_products',
    '[main] List products, optionally filtered by search text and status.',
    {
      search: str('Text to match in product name or description'),
      status: str(),
    },
  ),
  tool('main__create_product', '[main] Create a simple product. Price is a decimal string.', {
    name: str(),
    regular_price: str('Price in store currency, for example "199.50"'),
  }),
  tool('main__list_orders', '[main] List orders. Use date or after/before, not both.', {
    date: str('Resolved in the store timezone'),
    status: ORDER_STATUS,
  }),
  tool('main__get_order', '[main] One order with totals, payment method and line items.', {
    order_id: { type: 'integer' },
  }),
  tool('main__update_order_status', '[main] Change an order status, optionally adding a note.', {
    order_id: { type: 'integer' },
    status: str(),
    note: str('Private order note'),
  }),
  tool('gh__search_code', '[gh] Search code across repositories.', { q: str() }),
  tool('gh__search_issues', '[gh] Search issues and pull requests.', { q: str() }),
  tool('gh__search_repositories', '[gh] Find repositories by name or topic.', { query: str() }),
  tool('gh__get_file_contents', '[gh] Read a file from a repository.', { path: str() }),
  tool('gh__list_commits', '[gh] List commits on a branch.', { sha: str() }),
  tool('gh__get_issue', '[gh] Read one issue.', { issue_number: { type: 'integer' } }),
  tool('gh__create_issue', '[gh] Open an issue.', { title: str(), body: str() }),
  tool('gh__list_pull_requests', '[gh] List pull requests.', { state: str() }),
  tool('gh__get_pull_request', '[gh] Read one pull request.', { pull_number: { type: 'integer' } }),
  tool('gh__create_pull_request', '[gh] Open a pull request.', { title: str(), head: str() }),
];

describe('searchTools', () => {
  it('has the 19 live tools in the fixture', () => {
    expect(live).toHaveLength(19);
  });

  it('ranks fx__convert_currency first for "convert currency"', () => {
    expect(searchTools(live, 'convert currency')[0]?.name).toBe('fx__convert_currency');
  });

  it('finds main__list_orders for "order status"', () => {
    expect(searchTools(live, 'order status').map((t) => t.name)).toContain('main__list_orders');
  });

  it('finds a tool through a parameter description only', () => {
    expect(searchTools(live, 'timezone')[0]?.name).toBe('main__get_info');
    expect(searchTools(live, 'processing completed').map((t) => t.name)).toContain(
      'main__list_orders',
    );
  });

  it('splits exposed names on underscores', () => {
    expect(searchTools(live, 'list orders')[0]?.name).toBe('main__list_orders');
  });

  it('defaults the limit to 5 and honours an explicit one', () => {
    expect(searchTools(live, 'get')).toHaveLength(5);
    expect(searchTools(live, 'get', 2)).toHaveLength(2);
  });

  it('refuses a limit of 0 and 11 in the input schema', () => {
    expect(searchToolsInput.safeParse({ query: 'x', limit: 0 }).success).toBe(false);
    expect(searchToolsInput.safeParse({ query: 'x', limit: 11 }).success).toBe(false);
    expect(searchToolsInput.parse({ query: 'x' }).limit).toBe(5);
    expect(searchToolsInput.safeParse({ query: '' }).success).toBe(false);
    expect(searchToolsInput.safeParse({ query: 'x'.repeat(201) }).success).toBe(false);
  });

  it('sorts equal scores by exposed name', () => {
    const same = ['b__x', 'a__x', 'c__x'].map((n) => tool(n, 'same words here'));
    expect(searchTools(same, 'words').map((t) => t.name)).toEqual(['a__x', 'b__x', 'c__x']);
  });

  it('returns an empty list when nothing matches', () => {
    expect(searchTools(live, 'zzqqxx')).toEqual([]);
  });

  it('returns name, description and inputSchema unchanged', () => {
    const hit = searchTools(live, 'convert currency')[0];
    expect(hit).toEqual(live.find((t) => t.name === 'fx__convert_currency'));
  });

  it('indexes and searches 500 tools in under 50 ms', () => {
    const many = Array.from({ length: 500 }, (_, i) =>
      tool(`srv${i % 20}__tool_${i}`, `Does thing number ${i} with widgets and gadgets`, {
        item: str(`The item for ${i}`),
      }),
    );
    searchTools(many, 'warm up');
    const t0 = performance.now();
    const hits = searchTools(many, 'widgets gadgets 123');
    expect(performance.now() - t0).toBeLessThan(50);
    expect(hits.length).toBeGreaterThan(0);
  });
});

describe('tool mode', () => {
  it('lets the override search beat a full key', () => {
    expect(effectiveToolMode('full', 5, 'search')).toBe('search');
  });

  it('lets the override full beat a search key', () => {
    expect(effectiveToolMode('search', 500, 'full')).toBe('full');
  });

  it('switches auto at 41 and not at 40', () => {
    expect(SEARCH_THRESHOLD).toBe(40);
    expect(effectiveToolMode('auto', 40)).toBe('full');
    expect(effectiveToolMode('auto', 41)).toBe('search');
  });

  it('uses the key mode without an override', () => {
    expect(effectiveToolMode('search', 1)).toBe('search');
    expect(effectiveToolMode('full', 100)).toBe('full');
  });

  it('parses the override and refuses other values', () => {
    expect(parseToolModeOverride('search')).toBe('search');
    expect(parseToolModeOverride('full')).toBe('full');
    expect(parseToolModeOverride(undefined)).toBeUndefined();
    for (const bad of ['auto', 'SEARCH', 'x', '', ['search', 'full']]) {
      expect(() => parseToolModeOverride(bad)).toThrow();
    }
  });
});

describe('meta tools', () => {
  it('defines search_tools and call_tool sorted by name', () => {
    expect(META_TOOLS.map((t) => t.name)).toEqual(['call_tool', 'search_tools']);
    for (const t of META_TOOLS) expect(t.description?.length).toBeGreaterThan(20);
  });

  it('validates call_tool input', () => {
    expect(callToolInput.safeParse({ name: 'fx__get_info' }).success).toBe(true);
    expect(callToolInput.safeParse({ name: 'a', arguments: { x: 1 } }).success).toBe(true);
    expect(callToolInput.safeParse({ name: 'a', arguments: 'x' }).success).toBe(false);
    expect(callToolInput.safeParse({}).success).toBe(false);
  });
});
