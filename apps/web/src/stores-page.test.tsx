// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { routes } from './router';

const me = { id: 'u1', email: 'admin@example.com', name: null, role: 'admin' };
const store = (slug: string, over: Record<string, unknown> = {}) => ({
  id: `id-${slug}`,
  slug,
  name: `Store ${slug}`,
  status: 'ready',
  statusReason: null,
  lastStep: 'ready',
  url: `http://${slug}.shop.test`,
  attempt: 0,
  createdAt: '2026-10-13T10:00:00Z',
  readyAt: '2026-10-13T10:02:00Z',
  deadlineAt: null,
  owner: { id: 'u1', email: 'admin@example.com' },
  deletable: true,
  seeded: false,
  ...over,
});
const answers: Record<string, unknown> = {
  '/api/me': { user: me },
  '/api/config': { gatewayUrl: 'http://mcp.test/mcp', version: 'test' },
  '/api/stores': { stores: [] },
};

describe('Stores page through the real routes', () => {
  beforeEach(() => {
    // The local dashboard is plain http, where crypto.randomUUID does not exist.
    vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) });
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (url: string) =>
          new Response(JSON.stringify(answers[url] ?? {}), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('opens the Create store form instead of the not found screen', async () => {
    const router = createMemoryRouter(routes, { initialEntries: ['/stores'] });
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Create store' }));
    expect(await screen.findByRole('dialog', { name: 'Create store' })).toBeTruthy();
    expect(screen.getByLabelText('Name')).toBeTruthy();
    expect(screen.queryByText('Page not found.')).toBeNull();
    expect(router.state.location.pathname).toBe('/stores');
  });

  it('shows the seeded store a disabled Delete with a reason, and other stores an active one', async () => {
    answers['/api/stores'] = {
      stores: [store('main', { deletable: false, seeded: true }), store('shop-two')],
    };
    const router = createMemoryRouter(routes, { initialEntries: ['/stores'] });
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    const buttons = await screen.findAllByRole('button', { name: 'Delete' });
    expect(buttons).toHaveLength(2);
    const [main, other] = buttons as HTMLButtonElement[];
    expect(main!.disabled).toBe(true);
    expect(main!.title).toBe('The demo store can’t be deleted');
    expect(other!.disabled).toBe(false);
    const confirm = vi.spyOn(window, 'confirm');
    fireEvent.click(main!);
    expect(confirm).not.toHaveBeenCalled();
    answers['/api/stores'] = { stores: [] };
  });
  it('keeps a deleted store visible as Deleting until the API stops listing it', async () => {
    let listed = [store('abc')];
    const f = vi.fn(async (url: string, init?: { method?: string }) => {
      if (url === '/api/stores/id-abc' && init?.method === 'DELETE') {
        listed = [store('abc', { status: 'deleting', lastStep: 'queued', deletable: false })];
        return new Response(JSON.stringify({ store: listed[0] }), { status: 202 });
      }
      const body = url === '/api/stores' ? { stores: listed } : (answers[url] ?? {});
      return new Response(JSON.stringify(body), { status: 200 });
    });
    vi.stubGlobal('fetch', f);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const router = createMemoryRouter(routes, { initialEntries: ['/stores'] });
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('Deleting')).toBeTruthy();
    expect(screen.getByText('Store abc')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
    // Teardown done: the next list answer drops the row.
    listed = [];
    await waitFor(() => expect(screen.queryByText('Store abc')).toBeNull(), { timeout: 4000 });
  });
});
