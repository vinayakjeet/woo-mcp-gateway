// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { routes } from './router';

const me = { id: 'u1', email: 'asha@example.com', name: null, role: 'member' };
const item = (id: number, over: Record<string, unknown>) => ({
  id,
  ts: '2026-10-16T10:00:00.000000Z',
  userEmail: 'asha@example.com',
  via: 'api_key',
  serverSlug: 'fx',
  toolName: 'fx__get_info',
  exposedName: 'fx__get_info',
  outcome: 'ok',
  durationMs: 12,
  errorMessage: null,
  replica: 'gw-1',
  ...over,
});
const items = [
  item(3, {
    via: 'oauth',
    serverSlug: '',
    toolName: 'oauth_grant_revoked',
    exposedName: 'dcr_abc',
    durationMs: 0,
    errorMessage: 'revoked by admin@example.com',
  }),
  item(2, { outcome: 'upstream_error', errorMessage: 'boom', toolName: 'fx__convert' }),
  item(1, {}),
];

describe('Audit log through the real routes', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const answers: Record<string, unknown> = {
          '/api/me': { user: me },
          '/api/config': { gatewayUrl: 'http://mcp.test/mcp', version: 'test' },
          '/api/servers': { servers: [] },
        };
        if (url.startsWith('/api/audit'))
          return new Response(JSON.stringify({ items, nextCursor: null }));
        return new Response(JSON.stringify(answers[url] ?? {}), { status: 200 });
      }),
    );
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  async function rows() {
    const router = createMemoryRouter(routes, { initialEntries: ['/audit'] });
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    const table = await screen.findByRole('table');
    await waitFor(() => expect(within(table).getAllByRole('row')).toHaveLength(4));
    return within(table).getAllByRole('row');
  }

  it('shows a revoked grant as a normal event: OAuth in the server cell, a neutral detail, no error look', async () => {
    const [, revoke, failed, ok] = await rows();
    expect(within(revoke!).getByText('OAuth')).toBeTruthy();
    expect(within(revoke!).getByText('Revoked by admin@example.com')).toBeTruthy();
    // The raw message is not a tooltip, and the pill is the same ok pill as a good call.
    expect(revoke!.getAttribute('title') ?? '').toBe('');
    const pill = (r: HTMLElement) => within(r).getByText(/^(ok|upstream_error)$/).className;
    expect(pill(revoke!)).toBe(pill(ok!));
    expect(pill(revoke!)).not.toBe(pill(failed!));
    expect(revoke!.className).not.toMatch(/bad/);
    // A failed tool call is unchanged: its message is still the tooltip.
    expect(failed!.getAttribute('title')).toBe('boom');
    expect(within(failed!).queryByText(/Revoked/)).toBeNull();
  });

  it('shows no duration for an event, since nothing was timed', async () => {
    const [, revoke, , ok] = await rows();
    expect(within(revoke!).queryByText('0 ms')).toBeNull();
    expect(within(ok!).getByText('12 ms')).toBeTruthy();
  });
});
