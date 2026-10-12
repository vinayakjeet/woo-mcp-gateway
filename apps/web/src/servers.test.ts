import { describe, expect, it } from 'vitest';
import { formFromServer, serverCreate, serverPatch, serverPill } from './servers';
import type { Server } from './types';

const server = (over: Partial<Server> = {}): Server => ({
  id: 'id',
  slug: 'gh',
  name: 'GitHub',
  url: 'https://gh.example/mcp',
  kind: 'external',
  managed: false,
  enabled: true,
  approval: 'approved',
  protocolMode: 'legacy',
  timeoutMs: 15000,
  auth: { type: 'bearer', headerName: null, hasSecret: true },
  status: null,
  tools: [],
  ...over,
});
const status = (state: 'connected' | 'unreachable' | 'disabled' | 'pending') => ({
  state,
  toolCount: 0,
  errorKind: null,
  errorMessage: null,
  checkedAt: null,
  lastOkAt: null,
});

describe('serverPill', () => {
  it.each([
    [server({ enabled: false, status: status('connected') }), 'Disabled'],
    [server({ approval: 'pending' }), 'Pending approval'],
    [server({ status: status('connected') }), 'Connected'],
    [server({ status: status('unreachable') }), 'Unreachable'],
    [server({ status: null }), 'Checking'],
    [server({ status: status('pending') }), 'Checking'],
    [server({ status: status('disabled') }), 'Checking'],
  ])('%#: %s', (s, label) => expect(serverPill(s).label).toBe(label));
});

describe('serverPatch', () => {
  it('sends nothing when nothing changed', () => {
    expect(serverPatch(formFromServer(server()), server())).toEqual({});
  });
  it('sends a typed secret and keeps it out otherwise', () => {
    const s = server();
    expect(serverPatch({ ...formFromServer(s), secret: 'new' }, s)).toEqual({
      auth: { type: 'bearer', secret: 'new' },
    });
    expect(serverPatch({ ...formFromServer(s), name: ' Renamed ' }, s)).toEqual({
      name: 'Renamed',
    });
  });
  it('sends auth when the type or the header name changes', () => {
    const s = server({ auth: { type: 'header', headerName: 'X-Key', hasSecret: true } });
    expect(serverPatch({ ...formFromServer(s), authType: 'none' }, s)).toEqual({
      auth: { type: 'none' },
    });
    expect(serverPatch({ ...formFromServer(s), headerName: 'X-Other' }, s)).toEqual({
      auth: { type: 'header', headerName: 'X-Other' },
    });
  });
  it('sends only the timeout for a managed server', () => {
    const s = server({ managed: true });
    expect(
      serverPatch({ ...formFromServer(s), name: 'x', url: 'http://y', timeoutMs: 20000 }, s),
    ).toEqual({ timeoutMs: 20000 });
  });
});

describe('serverCreate', () => {
  it('trims fields and omits an empty secret', () => {
    const f = {
      ...formFromServer(null),
      name: ' GitHub ',
      slug: ' gh ',
      url: ' https://gh.example/mcp ',
      authType: 'bearer' as const,
    };
    expect(serverCreate(f)).toEqual({
      name: 'GitHub',
      slug: 'gh',
      url: 'https://gh.example/mcp',
      auth: { type: 'bearer' },
      timeoutMs: 15000,
      protocolMode: 'legacy',
    });
  });
});
