// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { routes } from './router';

const admin = { id: 'u1', email: 'admin@example.com', name: null, role: 'admin' };
const member = { id: 'u2', email: 'asha@example.com', name: null, role: 'member' };
const limits = { allowedImagePrefixes: ['fx-mcp:'], maxCpu: '500m', maxMemory: '256Mi' };
const server = (slug: string, over: Record<string, unknown> = {}) => ({
  id: `id-${slug}`,
  slug,
  image: 'fx-mcp:dev',
  port: 8080,
  path: '/mcp',
  env: [],
  secretEnvNames: ['DEMO_SECRET'],
  cpu: '200m',
  memory: '128Mi',
  status: 'ready',
  reason: null,
  serverId: `srv-${slug}`,
  url: `http://${slug}.mcp-hosted.svc.cluster.local:8080/mcp`,
  createdAt: '2026-10-15T10:00:00Z',
  ...over,
});

type Call = { url: string; method: string; body: unknown };
let calls: Call[];
let me: typeof admin;
let hosted: { servers: unknown[]; limits: typeof limits };
let onPost: (body: unknown) => Response;

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
const gets = () => calls.filter((c) => c.url === '/api/hosted' && c.method === 'GET').length;

describe('Hosted servers page through the real routes', () => {
  beforeEach(() => {
    calls = [];
    me = admin;
    hosted = { servers: [], limits };
    onPost = () => json({ server: server('fx2', { status: 'pending' }) }, 201);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
        const method = init?.method ?? 'GET';
        const body = init?.body ? JSON.parse(init.body) : undefined;
        calls.push({ url, method, body });
        if (url === '/api/me') return json({ user: me });
        if (url === '/api/config')
          return json({ gatewayUrl: 'http://mcp.test/mcp', version: 'test' });
        if (url === '/api/hosted' && method === 'POST') return onPost(body);
        if (url === '/api/hosted') return json(hosted);
        if (url.startsWith('/api/hosted/') && method === 'DELETE') {
          // Like the API: the row is Deleting from now on.
          hosted.servers = [server('fx2', { status: 'deleting' })];
          return json({ server: hosted.servers[0] }, 202);
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

  it('admin sees the nav entry and the table', async () => {
    hosted.servers = [server('fx2')];
    renderAt('/servers');
    const nav = await screen.findByRole('link', { name: 'Hosted servers' });
    fireEvent.click(nav);
    expect(await screen.findByRole('heading', { name: 'Hosted servers' })).toBeTruthy();
    const row = (await screen.findByText('fx2')).closest('tr')!;
    expect(within(row).getByText('fx-mcp:dev')).toBeTruthy();
    expect(within(row).getByText('200m')).toBeTruthy();
    expect(within(row).getByText('128Mi')).toBeTruthy();
  });

  it('a member has no nav entry and gets what Members gives a member', async () => {
    me = member as typeof admin;
    renderAt('/hosted');
    expect(await screen.findByText('Only admins manage hosted servers.')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Hosted servers' })).toBeNull();
    expect(calls.some((c) => c.url === '/api/hosted')).toBe(false);
  });

  it('Create posts the form and refetches', async () => {
    renderAt('/hosted');
    fireEvent.click(await screen.findByRole('button', { name: 'Create hosted server' }));
    const dialog = await screen.findByRole('dialog', { name: 'Create hosted server' });
    fireEvent.change(within(dialog).getByLabelText('Slug'), { target: { value: 'fx2' } });
    fireEvent.change(within(dialog).getByLabelText('Image'), { target: { value: 'fx-mcp:dev' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add variable' }));
    fireEvent.change(within(dialog).getByLabelText('Variable name 1'), {
      target: { value: 'MODE' },
    });
    fireEvent.change(within(dialog).getByLabelText('Variable value 1'), {
      target: { value: 'demo' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add secret' }));
    fireEvent.change(within(dialog).getByLabelText('Secret name 1'), {
      target: { value: 'DEMO_SECRET' },
    });
    fireEvent.change(within(dialog).getByLabelText('Secret value 1'), {
      target: { value: 'hunter2' },
    });
    const before = gets();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({
      slug: 'fx2',
      image: 'fx-mcp:dev',
      port: 8080,
      path: '/mcp',
      env: [{ name: 'MODE', value: 'demo' }],
      secretEnv: [{ name: 'DEMO_SECRET', value: 'hunter2' }],
      cpu: '200m',
      memory: '128Mi',
    });
    await waitFor(() => expect(gets()).toBeGreaterThan(before));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('secret env inputs are password fields and are cleared after submit', async () => {
    onPost = () =>
      json({ error: 'invalid_hosted', issues: [{ path: 'slug', message: 'Invalid slug' }] }, 400);
    renderAt('/hosted');
    fireEvent.click(await screen.findByRole('button', { name: 'Create hosted server' }));
    const dialog = await screen.findByRole('dialog', { name: 'Create hosted server' });
    fireEvent.change(within(dialog).getByLabelText('Slug'), { target: { value: 'fx2' } });
    fireEvent.change(within(dialog).getByLabelText('Image'), { target: { value: 'fx-mcp:dev' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add secret' }));
    const value = within(dialog).getByLabelText('Secret value 1') as HTMLInputElement;
    expect(value.type).toBe('password');
    expect(value.autocomplete).toBe('off');
    fireEvent.change(value, { target: { value: 'hunter2' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    await within(dialog).findByText(/slug: Invalid slug/i);
    // The form stays open for a fix, but a secret is never kept in the page after a send.
    expect((within(dialog).getByLabelText('Secret value 1') as HTMLInputElement).value).toBe('');
    expect((within(dialog).getByLabelText('Slug') as HTMLInputElement).value).toBe('fx2');
  });

  it('a 400 image_not_allowed shows the allowed prefixes', async () => {
    onPost = () =>
      json({ error: 'image_not_allowed', issues: [], allowedImagePrefixes: ['fx-mcp:'] }, 400);
    renderAt('/hosted');
    fireEvent.click(await screen.findByRole('button', { name: 'Create hosted server' }));
    const dialog = await screen.findByRole('dialog', { name: 'Create hosted server' });
    fireEvent.change(within(dialog).getByLabelText('Slug'), { target: { value: 'bb' } });
    fireEvent.change(within(dialog).getByLabelText('Image'), { target: { value: 'busybox:1.37' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    const alert = await within(dialog).findByRole('alert');
    expect(alert.textContent).toMatch(/not under an allowed prefix/i);
    expect(alert.textContent).toContain('fx-mcp:');
  });

  it('rows show the status pill and reason', async () => {
    hosted.servers = [
      server('fx2', { status: 'pending', reason: 'ImagePullBackOff' }),
      server('ok1'),
      server('bad1', { status: 'failed', reason: 'Deployment did not become available' }),
      server('gone', { status: 'deleting' }),
    ];
    renderAt('/hosted');
    const pending = (await screen.findByText('fx2')).closest('tr')!;
    expect(within(pending).getByText('Pending')).toBeTruthy();
    expect(within(pending).getByText('ImagePullBackOff')).toBeTruthy();
    expect(within(screen.getByText('ok1').closest('tr')!).getByText('Ready')).toBeTruthy();
    const failed = screen.getByText('bad1').closest('tr')!;
    expect(within(failed).getByText('Failed')).toBeTruthy();
    expect(within(failed).getByText('Deployment did not become available')).toBeTruthy();
    const deleting = screen.getByText('gone').closest('tr')!;
    expect(within(deleting).getByText('Deleting')).toBeTruthy();
    expect(within(deleting).queryByRole('button', { name: 'Delete' })).toBeNull();
  });

  it('refetches every 3 s while a row is pending or deleting and stops when none is', async () => {
    hosted.servers = [server('fx2', { status: 'pending' })];
    renderAt('/hosted');
    await screen.findByText('Pending');
    const first = gets();
    hosted.servers = [server('fx2')];
    await screen.findByText('Ready', {}, { timeout: 5000 });
    const settled = gets();
    expect(settled).toBeGreaterThan(first);
    await new Promise((r) => setTimeout(r, 3400));
    expect(gets()).toBe(settled);
  }, 15000);

  it('Delete asks for confirmation naming the slug', async () => {
    hosted.servers = [server('fx2')];
    const confirm = vi
      .spyOn(window, 'confirm')
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    renderAt('/hosted');
    const button = await screen.findByRole('button', { name: 'Delete' });
    fireEvent.click(button);
    expect(confirm.mock.calls[0]![0]).toContain('fx2');
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    fireEvent.click(button);
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'DELETE' && c.url === '/api/hosted/id-fx2')).toBe(true),
    );
    expect(await screen.findByText('Deleting')).toBeTruthy();
  });
});
