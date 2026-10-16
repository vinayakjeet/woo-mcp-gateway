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
  let grants: Array<Record<string, unknown>>;
  let deletes: string[];
  let urls: string[];
  beforeEach(() => {
    posts = [];
    deletes = [];
    urls = [];
    oauthEnabled = false;
    grants = [
      {
        clientId: 'dcr_abc',
        name: 'MCP Inspector',
        kind: 'dcr',
        host: null,
        approvedAt: '2026-10-16T09:00:00.000000Z',
        lastRefreshedAt: null,
      },
      {
        clientId: 'https://claude.ai/oauth/claude-code-client-metadata',
        name: 'Claude Code',
        kind: 'cimd',
        host: 'claude.ai',
        approvedAt: '2026-10-16T08:00:00.000000Z',
        lastRefreshedAt: '2026-10-16T09:30:00.000000Z',
      },
    ];
    listed = [key('a1', 'auto'), key('b2', 'search')];
    vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
        urls.push(url);
        if (url.startsWith('/api/oauth/grants/') && init?.method === 'DELETE') {
          deletes.push(url);
          const id = decodeURIComponent(url.slice('/api/oauth/grants/'.length));
          grants = grants.filter((g) => g.clientId !== id);
          return new Response(null, { status: 204 });
        }
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
          '/api/oauth/grants': { grants },
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

  describe('Connected apps', () => {
    it('lists each app with its source, when it connected and when it last refreshed', async () => {
      oauthEnabled = true;
      renderKeys();
      const table = await screen.findByRole('table', { name: 'Connected apps' });
      const heads = within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent);
      expect(heads).toEqual(['App', 'Source', 'Connected', 'Last refreshed', '']);
      const rows = within(table).getAllByRole('row');
      expect(within(rows[1]!).getByText('MCP Inspector')).toBeTruthy();
      expect(within(rows[1]!).getByText('unverified')).toBeTruthy();
      expect(within(rows[1]!).getByText('never')).toBeTruthy();
      expect(within(rows[2]!).getByText('Claude Code')).toBeTruthy();
      expect(within(rows[2]!).getByText('claude.ai')).toBeTruthy();
      expect(within(rows[2]!).queryByText('never')).toBeNull();
    });

    it('Revoke asks once, calls the API with the encoded client id, and drops the row', async () => {
      oauthEnabled = true;
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
      renderKeys();
      const table = await screen.findByRole('table', { name: 'Connected apps' });
      const cimdRow = within(table).getByText('Claude Code').closest('tr')!;
      fireEvent.click(within(cimdRow).getByRole('button', { name: 'Revoke' }));
      expect(confirm).toHaveBeenCalledOnce();
      expect(confirm.mock.calls[0]![0]).toContain('Claude Code');
      expect(deletes).toEqual([]);

      confirm.mockReturnValue(true);
      fireEvent.click(within(cimdRow).getByRole('button', { name: 'Revoke' }));
      await waitFor(() =>
        expect(deletes).toEqual([
          `/api/oauth/grants/${encodeURIComponent('https://claude.ai/oauth/claude-code-client-metadata')}`,
        ]),
      );
      await waitFor(() => expect(screen.queryByText('Claude Code')).toBeNull());
      expect(screen.getByText('MCP Inspector')).toBeTruthy();
    });

    it('shows a message and no table when there is nothing connected', async () => {
      oauthEnabled = true;
      grants = [];
      renderKeys();
      expect(await screen.findByText('No apps connected.')).toBeTruthy();
      expect(screen.queryByRole('table', { name: 'Connected apps' })).toBeNull();
    });

    it('is absent, and never asks the API, when oauthEnabled is false', async () => {
      renderKeys();
      await screen.findByRole('table');
      expect(screen.queryByText('Connected apps')).toBeNull();
      expect(urls).not.toContain('/api/oauth/grants');
    });
  });
});
