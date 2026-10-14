// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { routes } from './router';

const admin = { id: 'u1', email: 'admin@example.com', name: null, role: 'admin' };
const member = { id: 'u2', email: 'm@example.com', name: null, role: 'member' };
const rule = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  role: 'member',
  serverPattern: '*',
  toolPattern: 'list_*',
  effect: 'allow',
  priority: 0,
  createdAt: '2026-10-14T10:00:00Z',
  ...over,
});
const tool = (exposedName: string, roles: string[]) => ({
  exposedName,
  title: null,
  description: null,
  readOnly: false,
  state: 'active',
  roles,
});
const servers = [
  {
    id: 's1',
    slug: 'main',
    name: 'Main Store',
    url: 'http://x',
    kind: 'store',
    managed: true,
    enabled: true,
    approval: 'approved',
    protocolMode: 'auto',
    timeoutMs: 15000,
    auth: { type: 'bearer', headerName: null, hasSecret: true },
    status: {
      state: 'connected',
      toolCount: 2,
      errorKind: null,
      errorMessage: null,
      checkedAt: null,
      lastOkAt: null,
    },
    tools: [
      tool('main__list_orders', ['admin', 'member']),
      tool('main__create_product', ['admin']),
    ],
  },
];

let who = admin;
let policies = [
  rule('p-priority', {
    serverPattern: 'main',
    toolPattern: 'create_*',
    effect: 'deny',
    priority: 9,
  }),
  rule('p-list'),
];
let calls: Array<{ url: string; method: string; body: unknown }> = [];

function open() {
  const router = createMemoryRouter(routes, { initialEntries: ['/policies'] });
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

describe('Policies page through the real routes', () => {
  beforeEach(() => {
    who = admin;
    policies = [
      rule('p-priority', {
        serverPattern: 'main',
        toolPattern: 'create_*',
        effect: 'deny',
        priority: 9,
      }),
      rule('p-list'),
    ];
    calls = [];
    vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
        const method = init?.method ?? 'GET';
        calls.push({ url, method, body: init?.body ? JSON.parse(init.body) : undefined });
        const json = (b: unknown, status = 200) =>
          new Response(JSON.stringify(b), {
            status,
            headers: { 'content-type': 'application/json' },
          });
        if (url === '/api/me') return json({ user: who });
        if (url === '/api/config') return json({ gatewayUrl: 'http://mcp.test/mcp', version: 't' });
        if (url === '/api/servers') return json({ servers });
        if (url === '/api/policies' && method === 'GET') return json({ policies });
        if (url === '/api/policies' && method === 'POST') {
          const p = rule('p-new', JSON.parse(init!.body!));
          policies = [p, ...policies];
          return json({ policy: p }, 201);
        }
        if (url.startsWith('/api/policies/') && method === 'DELETE') {
          policies = policies.filter((p) => url !== `/api/policies/${p.id}`);
          return new Response(null, { status: 204 });
        }
        return json({});
      }),
    );
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('lists rules in the order the API gives, with a nav link', async () => {
    open();
    const rows = await screen.findAllByTestId('policy-row');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText('create_*')).toBeTruthy();
    expect(within(rows[0]!).getByText('deny')).toBeTruthy();
    expect(within(rows[1]!).getByText('list_*')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Policies' })).toBeTruthy();
  });

  it('shows Add and Delete to an admin and neither to a member', async () => {
    open();
    expect(await screen.findByRole('button', { name: 'Add rule' })).toBeTruthy();
    expect(await screen.findAllByRole('button', { name: 'Delete' })).toHaveLength(2);
    cleanup();
    who = member;
    open();
    await screen.findAllByTestId('policy-row');
    expect(screen.queryByRole('button', { name: 'Add rule' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
  });

  it('posts the form and refetches the rules and the servers', async () => {
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Add rule' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add rule' });
    fireEvent.change(within(dialog).getByLabelText('Role'), { target: { value: 'member' } });
    fireEvent.change(within(dialog).getByLabelText('Server pattern'), {
      target: { value: 'main' },
    });
    fireEvent.change(within(dialog).getByLabelText('Tool pattern'), {
      target: { value: 'list_orders' },
    });
    fireEvent.change(within(dialog).getByLabelText('Effect'), { target: { value: 'deny' } });
    fireEvent.change(within(dialog).getByLabelText('Priority'), { target: { value: '10' } });
    const before = calls.filter((c) => c.url === '/api/servers').length;
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add rule' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      role: 'member',
      serverPattern: 'main',
      toolPattern: 'list_orders',
      effect: 'deny',
      priority: 10,
    });
    expect(await screen.findAllByTestId('policy-row')).toHaveLength(3);
    await waitFor(() =>
      expect(calls.filter((c) => c.url === '/api/servers').length).toBeGreaterThan(before),
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('asks before it deletes, and deletes after a yes', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    open();
    const buttons = await screen.findAllByRole('button', { name: 'Delete' });
    fireEvent.click(buttons[1]!);
    expect(confirm).toHaveBeenCalledOnce();
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    confirm.mockReturnValue(true);
    fireEvent.click(buttons[1]!);
    await waitFor(() => expect(calls.some((c) => c.url === '/api/policies/p-list')).toBe(true));
    await waitFor(() => expect(screen.getAllByTestId('policy-row')).toHaveLength(1));
  });

  it('switches the preview with the role select', async () => {
    open();
    const preview = await screen.findByTestId('preview');
    await waitFor(() => expect(within(preview).getByText('main__list_orders')).toBeTruthy());
    expect(within(preview).queryByText('main__create_product')).toBeNull();
    fireEvent.change(screen.getByLabelText('Preview as'), { target: { value: 'admin' } });
    expect(within(preview).getByText('main__create_product')).toBeTruthy();
  });

  it('shows the roles column on the Servers page tool table', async () => {
    const router = createMemoryRouter(routes, { initialEntries: ['/servers'] });
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByText('Main Store'));
    const create = (await screen.findByText('main__create_product')).closest('tr')!;
    expect(within(create).getByText('admin')).toBeTruthy();
    const list = screen.getByText('main__list_orders').closest('tr')!;
    expect(within(list).getByText('admin, member')).toBeTruthy();
  });
});
