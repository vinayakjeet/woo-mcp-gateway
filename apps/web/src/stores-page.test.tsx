// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { routes } from './router';

const me = { id: 'u1', email: 'admin@example.com', name: null, role: 'admin' };
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
});
