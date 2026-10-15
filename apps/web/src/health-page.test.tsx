// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { routes } from './router';

const admin = { id: 'u1', email: 'admin@example.com', name: null, role: 'admin' };
const member = { id: 'u2', email: 'asha@example.com', name: null, role: 'member' };

const stat = (slug: string, over: Record<string, unknown> = {}) => ({
  slug,
  name: slug.toUpperCase(),
  kind: 'store',
  enabled: true,
  approval: 'approved',
  state: 'connected',
  errorKind: null,
  errorMessage: null,
  checkedAt: new Date(Date.now() - 20_000).toISOString(),
  calls: 12,
  callsPerMinute: 0.2,
  outcomes: { ok: 12 },
  errorRate: 0.25,
  p50Ms: 120.4,
  p95Ms: 954.6,
  ...over,
});

let me: typeof admin;
let urls: string[];
let health: { status: number; body: unknown };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}
const healthGets = () => urls.filter((u) => u === '/api/stats/servers?window=60m').length;

describe('Health page through the real routes', () => {
  beforeEach(() => {
    urls = [];
    me = admin;
    health = {
      status: 200,
      body: {
        windowMinutes: 60,
        servers: [
          stat('main', {
            errorKind: 'refused',
            errorMessage: 'connection refused',
            state: 'unreachable',
          }),
          stat('fx', {
            kind: 'system',
            calls: 0,
            callsPerMinute: 0,
            errorRate: null,
            p50Ms: null,
            p95Ms: null,
          }),
        ],
      },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(url);
        if (url === '/api/me') return json({ user: me });
        if (url === '/api/config')
          return json({ gatewayUrl: 'http://mcp.test/mcp', version: 'test' });
        if (url.startsWith('/api/stats/servers')) return json(health.body, health.status);
        return json({});
      }),
    );
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([
    ['an admin', admin],
    ['a member', member],
  ])('%s sees the nav entry after Servers and the table', async (_who, user) => {
    me = user;
    renderAt('/servers');
    const nav = await screen.findByRole('link', { name: 'Health' });
    const links = screen.getAllByRole('link').map((l) => l.textContent);
    expect(links.indexOf('Health')).toBe(links.indexOf('Servers') + 1);
    nav.click();
    expect(await screen.findByRole('heading', { name: 'Health' })).toBeTruthy();
    expect(await screen.findByText('main')).toBeTruthy();
    expect(screen.getByText('fx')).toBeTruthy();
  });

  it('shows the pill, calls per minute, error rate, p50, p95 and the last error', async () => {
    renderAt('/health');
    const row = (await screen.findByText('main')).closest('tr')!;
    expect(within(row).getByText('Unreachable')).toBeTruthy();
    expect(within(row).getByText('0.20')).toBeTruthy();
    expect(within(row).getByText('25.0%')).toBeTruthy();
    expect(within(row).getByText('120 ms')).toBeTruthy();
    expect(within(row).getByText('955 ms')).toBeTruthy();
    expect(within(row).getByText('refused: connection refused')).toBeTruthy();
    expect(within(row).getByText(/20 s ago/)).toBeTruthy();
  });

  it('shows dashes for a server with no calls', async () => {
    renderAt('/health');
    const row = (await screen.findByText('fx')).closest('tr')!;
    const cells = within(row)
      .getAllByRole('cell')
      .map((c) => c.textContent);
    // Error rate, p50, p95 and the last error.
    expect(cells.filter((c) => c === '-')).toHaveLength(4);
    expect(within(row).getByText('0.00')).toBeTruthy();
    expect(within(row).getByText('Connected')).toBeTruthy();
  });

  it('refetches every 10 s', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    renderAt('/health');
    await screen.findByText('main');
    const before = healthGets();
    expect(before).toBe(1);
    vi.advanceTimersByTime(10_000);
    await waitFor(() => expect(healthGets()).toBe(2));
    vi.advanceTimersByTime(10_000);
    await waitFor(() => expect(healthGets()).toBe(3));
  });

  it('shows the error box when the API fails', async () => {
    health = { status: 500, body: { error: 'internal_error' } };
    renderAt('/health');
    expect(await screen.findByRole('alert')).toBeTruthy();
  });
});
