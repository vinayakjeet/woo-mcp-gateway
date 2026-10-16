// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { routes } from './router';

const me = { id: 'u1', email: 'asha@example.com', name: null, role: 'member' };
const key = (id: string, toolMode: string) => ({
  id,
  name: `key-${id}`,
  prefix: id.padEnd(8, 'x'),
  createdAt: '2026-10-13T10:00:00Z',
  lastUsedAt: null,
  revokedAt: null,
  expiresAt: null,
  toolMode,
});

function renderKeys() {
  const router = createMemoryRouter(routes, { initialEntries: ['/keys'] });
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe('My keys page through the real routes', () => {
  let posts: unknown[];
  let listed: ReturnType<typeof key>[];
  let oauthEnabled: boolean;
  beforeEach(() => {
    posts = [];
    oauthEnabled = false;
    listed = [key('a1', 'auto'), key('b2', 'search')];
    vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
        if (url === '/api/keys' && init?.method === 'POST') {
          const body = JSON.parse(init.body ?? '{}') as { name: string; toolMode: string };
          posts.push(body);
          const made = key('c3', body.toolMode);
          listed = [made, ...listed];
          return new Response(JSON.stringify({ key: made, secret: 'urk_c3xxxxxx_secret' }), {
            status: 201,
          });
        }
        const answers: Record<string, unknown> = {
          '/api/me': { user: me },
          '/api/config': { gatewayUrl: 'http://mcp.test/mcp', version: 'test', oauthEnabled },
          '/api/keys': { keys: listed },
        };
        return new Response(JSON.stringify(answers[url] ?? {}), { status: 200 });
      }),
    );
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows the OAuth connect command, with no key, only when oauthEnabled', async () => {
    renderKeys();
    await screen.findByRole('table');
    expect(screen.queryByText(/urumi-oauth/)).toBeNull();
    cleanup();

    oauthEnabled = true;
    renderKeys();
    const cmd = await screen.findByText(/urumi-oauth/);
    expect(cmd.textContent).toBe('claude mcp add --transport http urumi-oauth http://mcp.test/mcp');
    expect(screen.getByText(/No key needed/)).toBeTruthy();
  });

  it('shows a mode column with each key mode', async () => {
    renderKeys();
    const table = await screen.findByRole('table');
    expect(within(table).getByRole('columnheader', { name: 'Mode' })).toBeTruthy();
    const rows = within(table).getAllByRole('row');
    expect(within(rows[1]!).getByText('auto')).toBeTruthy();
    expect(within(rows[2]!).getByText('search')).toBeTruthy();
  });

  it('sends the chosen mode when it creates a key, and auto by default', async () => {
    renderKeys();
    const name = await screen.findByLabelText('New key name');
    fireEvent.change(name, { target: { value: 'plain' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create key' }));
    await waitFor(() => expect(posts).toEqual([{ name: 'plain', toolMode: 'auto' }]));
    cleanup();

    renderKeys();
    fireEvent.change(await screen.findByLabelText('New key name'), {
      target: { value: 'claude-search' },
    });
    fireEvent.change(screen.getByLabelText('Tool mode'), { target: { value: 'search' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create key' }));
    await waitFor(() =>
      expect(posts.at(-1)).toEqual({ name: 'claude-search', toolMode: 'search' }),
    );
    expect(await screen.findByText(/urk_c3xxxxxx_secret/)).toBeTruthy();
  });
});
