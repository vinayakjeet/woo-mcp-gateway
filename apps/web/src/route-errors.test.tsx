// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, type RouteObject } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { routes } from './router';

const answers: Record<string, unknown> = {
  '/api/me': { user: { id: 'u1', email: 'admin@example.com', name: null, role: 'admin' } },
  '/api/config': { gatewayUrl: 'http://mcp.test/mcp', version: 'test' },
};

function Boom(): never {
  throw new Error('boom from a page');
}

// The real route tree with one extra page that always throws while rendering.
function withBoom(): RouteObject[] {
  return routes.map((r): RouteObject => {
    if (r.path !== '/') return r;
    const boom: RouteObject = { path: 'boom', Component: Boom };
    return { ...r, children: [...(r.children ?? []), boom] } as RouteObject;
  });
}

function open(path: string, tree: RouteObject[] = routes) {
  const router = createMemoryRouter(tree, { initialEntries: [path] });
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

describe('route errors', () => {
  let logged: { mock: { calls: unknown[][] }; mockRestore(): void };
  beforeEach(() => {
    logged = vi.spyOn(console, 'error').mockImplementation(() => {});
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
    logged.mockRestore();
  });

  it('keeps "Page not found" for an unknown route', async () => {
    open('/no/such/page');
    expect(await screen.findByText('Page not found.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Back to the dashboard' })).toBeTruthy();
    expect(screen.queryByText('Something went wrong.')).toBeNull();
  });

  it('shows "Something went wrong", a way back and a console error for a render error', async () => {
    open('/boom', withBoom());
    expect(await screen.findByText('Something went wrong.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Back to dashboard' })).toBeTruthy();
    expect(screen.queryByText('Page not found.')).toBeNull();
    const errors = logged.mock.calls.flat().filter((a): a is Error => a instanceof Error);
    expect(errors.map((e) => e.message)).toContain('boom from a page');
  });
});
