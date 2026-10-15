// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { routes } from './router';

const admin = { id: 'a1', email: 'admin@example.com', name: null, role: 'admin' };
const asha = {
  id: 'u2',
  email: 'asha@example.com',
  name: null,
  role: 'member',
  status: 'active',
  createdAt: '2026-10-13T10:00:00Z',
  activeKeys: 2,
};
type K = { id: string; rateLimitPerMin: number | null; revokedAt: string | null };
const key = (id: string, over: Partial<K> = {}) => ({
  id,
  name: `key-${id}`,
  prefix: id.padEnd(8, 'x'),
  createdAt: '2026-10-13T10:00:00Z',
  lastUsedAt: null,
  expiresAt: null,
  toolMode: 'auto',
  rateLimitPerMin: null,
  revokedAt: null,
  ...over,
});

describe('Members key limits through the real routes', () => {
  let keys: ReturnType<typeof key>[];
  let patches: Array<{ url: string; body: unknown }>;

  beforeEach(() => {
    keys = [
      key('k1'),
      key('k2', { rateLimitPerMin: 30 }),
      key('k3', { revokedAt: '2026-10-14T10:00:00Z' }),
    ];
    patches = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
        if (init?.method === 'PATCH' && url.startsWith('/api/keys/')) {
          const body = JSON.parse(init.body ?? '{}') as { rateLimitPerMin: number | null };
          patches.push({ url, body });
          const k = keys.find((x) => url.endsWith(x.id))!;
          k.rateLimitPerMin = body.rateLimitPerMin;
          return new Response(JSON.stringify({ key: k }), { status: 200 });
        }
        const answers: Record<string, unknown> = {
          '/api/me': { user: admin },
          '/api/config': { gatewayUrl: 'http://mcp.test/mcp', version: 'test' },
          '/api/users': { users: [asha] },
          '/api/users/u2/keys': { keys },
        };
        return new Response(JSON.stringify(answers[url] ?? {}), { status: 200 });
      }),
    );
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  async function openKeys() {
    const router = createMemoryRouter(routes, { initialEntries: ['/members'] });
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Keys' }));
    const name = await screen.findByText('key-k1');
    return name.closest('table')!;
  }
  const rowOf = (table: HTMLElement, name: string) => within(table).getByText(name).closest('tr')!;

  it("shows each key's limit or 'default'", async () => {
    const table = await openKeys();
    expect(within(table).getByRole('columnheader', { name: 'Limit/min' })).toBeTruthy();
    expect(within(rowOf(table, 'key-k1')).getByText('default')).toBeTruthy();
    expect(within(rowOf(table, 'key-k2')).getByText('30')).toBeTruthy();
  });

  it('offers no edit on a revoked key', async () => {
    const table = await openKeys();
    expect(within(rowOf(table, 'key-k3')).queryByRole('button', { name: 'Edit limit' })).toBeNull();
    expect(within(rowOf(table, 'key-k1')).getByRole('button', { name: 'Edit limit' })).toBeTruthy();
  });

  it('an admin edits the limit and the list refetches', async () => {
    const table = await openKeys();
    fireEvent.click(within(rowOf(table, 'key-k1')).getByRole('button', { name: 'Edit limit' }));
    const input = screen.getByLabelText('Limit per minute for key-k1');
    fireEvent.change(input, { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save limit' }));
    await waitFor(() =>
      expect(patches).toEqual([{ url: '/api/keys/k1', body: { rateLimitPerMin: 5 } }]),
    );
    await waitFor(() => expect(within(rowOf(table, 'key-k1')).getByText('5')).toBeTruthy());
    expect(screen.queryByLabelText('Limit per minute for key-k1')).toBeNull();
  });

  it('refuses values the API would refuse before sending them', async () => {
    const table = await openKeys();
    fireEvent.click(within(rowOf(table, 'key-k1')).getByRole('button', { name: 'Edit limit' }));
    const input = screen.getByLabelText('Limit per minute for key-k1');
    const save = screen.getByRole('button', { name: 'Save limit' }) as HTMLButtonElement;
    for (const bad of ['', '0', '10001', '1.5', 'abc']) {
      fireEvent.change(input, { target: { value: bad } });
      expect(save.disabled, bad).toBe(true);
    }
    fireEvent.change(input, { target: { value: '10000' } });
    expect(save.disabled).toBe(false);
    expect(patches).toEqual([]);
  });

  it('clearing sends null', async () => {
    const table = await openKeys();
    fireEvent.click(within(rowOf(table, 'key-k2')).getByRole('button', { name: 'Edit limit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Use default' }));
    await waitFor(() =>
      expect(patches).toEqual([{ url: '/api/keys/k2', body: { rateLimitPerMin: null } }]),
    );
    await waitFor(() => expect(within(rowOf(table, 'key-k2')).getByText('default')).toBeTruthy());
  });
});
