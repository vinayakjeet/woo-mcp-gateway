import { describe, expect, it } from 'vitest';
import { previewTools } from './policies';
import type { Server, Tool } from './types';

const tool = (exposedName: string, over: Partial<Tool> = {}): Tool => ({
  exposedName,
  title: null,
  description: null,
  readOnly: false,
  state: 'active',
  roles: ['admin', 'member'],
  ...over,
});
const server = (slug: string, tools: Tool[], over: Partial<Server> = {}): Server => ({
  id: slug,
  slug,
  name: slug,
  url: 'http://x',
  kind: 'external',
  managed: false,
  enabled: true,
  approval: 'approved',
  protocolMode: 'legacy',
  timeoutMs: 15000,
  auth: { type: 'none', headerName: null, hasSecret: false },
  status: {
    state: 'connected',
    toolCount: tools.length,
    errorKind: null,
    errorMessage: null,
    checkedAt: null,
    lastOkAt: null,
  },
  tools,
  ...over,
});

describe('previewTools', () => {
  it('keeps tools whose roles include the role', () => {
    const s = server('main', [
      tool('main__list_orders'),
      tool('main__create_product', { roles: ['admin'] }),
    ]);
    expect(previewTools([s], 'member').map((t) => t.exposedName)).toEqual(['main__list_orders']);
    expect(previewTools([s], 'admin').map((t) => t.exposedName)).toEqual([
      'main__create_product',
      'main__list_orders',
    ]);
  });

  it('drops tools of disabled, unreachable or pending servers and tools that are not active', () => {
    const servers = [
      server('a', [tool('a__x')], { enabled: false }),
      server('b', [tool('b__x')], { status: { ...server('b', []).status!, state: 'unreachable' } }),
      server('c', [tool('c__x')], { approval: 'pending' }),
      server('d', [tool('d__x')], { status: null }),
      server('e', [tool('e__changed', { state: 'changed' }), tool('e__ok')]),
    ];
    expect(previewTools(servers, 'admin').map((x) => x.exposedName)).toEqual(['e__ok']);
  });

  it('is sorted by exposed name across servers', () => {
    const servers = [server('z', [tool('z__a')]), server('a', [tool('a__b'), tool('a__a')])];
    expect(previewTools(servers, 'member').map((x) => x.exposedName)).toEqual([
      'a__a',
      'a__b',
      'z__a',
    ]);
  });
});
