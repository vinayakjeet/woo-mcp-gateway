// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { routes } from './router';

const authorize = '/oauth/authorize?client_id=dcr_abc&state=s';

function renderLogin(entry: string) {
  const router = createMemoryRouter(routes, { initialEntries: [entry] });
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

async function signIn() {
  fireEvent.change(await screen.findByLabelText('Email'), { target: { value: 'a@example.com' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw' } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
}

describe('Login page return path', () => {
  let assign: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/api/auth/login')
          return new Response(JSON.stringify({ user: { id: 'u1' } }), { status: 200 });
        if (url === '/api/me')
          return new Response(
            JSON.stringify({
              user: { id: 'u1', email: 'a@example.com', name: null, role: 'member' },
            }),
            { status: 200 },
          );
        return new Response('{}', { status: 200 });
      }),
    );
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('after login a next of /oauth/authorize?... does a full navigation there', async () => {
    const router = renderLogin(`/login?next=${encodeURIComponent(authorize)}`);
    await signIn();
    await waitFor(() => expect(assign).toHaveBeenCalledWith(authorize));
    expect(router.state.location.pathname).toBe('/login');
  });

  it.each([
    ['a protocol-relative URL', '//evil.example'],
    ['an absolute URL', 'https://evil.example'],
    ['another dashboard page', '/keys'],
    ['no next', null],
  ])('a next of %s goes to / and never navigates away', async (_name, next) => {
    const router = renderLogin(
      next === null ? '/login' : `/login?next=${encodeURIComponent(next)}`,
    );
    await signIn();
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
    expect(assign).not.toHaveBeenCalled();
  });
});
