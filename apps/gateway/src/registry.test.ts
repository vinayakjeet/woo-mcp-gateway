import type { Tool } from '@modelcontextprotocol/client';
import { describe, expect, it, vi } from 'vitest';
import { Registry, type RegistryOptions } from './registry.js';
import { captureLog, quietLog } from './test-helpers.js';
import type { CallOutcome, PersistedTool, ServerRecord } from './types.js';
import type { Upstream, UpstreamOptions, UpstreamState } from './upstream.js';

const tool = (name: string): Tool => ({
  name,
  description: `does ${name}`,
  inputSchema: { type: 'object' },
});

class FakeUpstream {
  started = false;
  stopped = false;
  private list: Tool[];
  constructor(
    readonly record: ServerRecord,
    readonly o: UpstreamOptions,
    names: string[],
    public state: UpstreamState,
  ) {
    this.list = names.map(tool);
  }
  start() {
    this.started = true;
  }
  async stop() {
    this.stopped = true;
  }
  tools() {
    return this.list;
  }
  setTools(names: string[]) {
    this.list = names.map(tool);
    this.o.onTools?.(this as unknown as Upstream);
  }
  async call(): Promise<CallOutcome> {
    return { outcome: 'ok', result: { content: [] } };
  }
}

type Spec = { tools?: string[]; state?: UpstreamState };

function record(slug: string, over: Partial<ServerRecord> = {}): ServerRecord {
  return {
    id: `id-${slug}`,
    slug,
    name: slug.toUpperCase(),
    url: `http://${slug}.test/mcp`,
    kind: 'external',
    enabled: true,
    approval: 'approved',
    timeoutMs: 15_000,
    protocolMode: 'legacy',
    auth: { type: 'none' },
    ...over,
  };
}

function setup(specs: Record<string, Spec>, o: Partial<RegistryOptions> = {}) {
  const fakes = new Map<string, FakeUpstream>();
  const registry = new Registry({
    log: quietLog,
    ...o,
    createUpstream: (r, uo) => {
      const s = specs[r.slug] ?? {};
      const f = new FakeUpstream(
        r,
        uo,
        s.tools ?? [],
        r.enabled ? (s.state ?? 'connected') : 'disabled',
      );
      fakes.set(r.slug, f);
      return f as unknown as Upstream;
    },
  });
  return { registry, fakes };
}

describe('Registry', () => {
  it('lists enabled, approved, connected servers sorted with source prefixes', () => {
    const { registry } = setup({
      main: { tools: ['list_orders', 'get_info'] },
      fx: { tools: ['get_info', 'convert_currency'] },
      down: { tools: ['x'], state: 'unreachable' },
      off: { tools: ['y'] },
      wait: { tools: ['z'] },
    });
    registry.apply(record('main', { kind: 'store', name: 'Main Store' }));
    registry.apply(record('fx', { name: 'FX' }));
    registry.apply(record('down'));
    registry.apply(record('off', { enabled: false }));
    registry.apply(record('wait', { approval: 'pending' }));
    const list = registry.list();
    expect(list.map((t) => t.name)).toEqual([
      'fx__convert_currency',
      'fx__get_info',
      'main__get_info',
      'main__list_orders',
    ]);
    expect(list.find((t) => t.name === 'main__get_info')?.description).toBe(
      '[Store: Main Store] does get_info',
    );
    expect(list.find((t) => t.name === 'fx__get_info')?.description).toBe('[FX] does get_info');
  });

  it('resolves exposed names to the server and the original tool name', () => {
    const { registry } = setup({ fx: { tools: ['get_info'] }, wait: { tools: ['z'] } });
    registry.apply(record('fx'));
    registry.apply(record('wait', { approval: 'pending' }));
    const r = registry.resolve('fx__get_info');
    expect(r?.toolName).toBe('get_info');
    expect(r?.upstream.record.slug).toBe('fx');
    expect(registry.resolve('nope__x')).toBeUndefined();
    expect(registry.resolve('wait__z')).toBeUndefined();
  });

  it('routes persisted tools of a disabled server so calls can say it is disabled', () => {
    const { registry } = setup({});
    const persisted: PersistedTool[] = [
      { name: 'y', exposedName: 'off__y', state: 'active', definitionHash: 'h' },
    ];
    registry.apply(record('off', { enabled: false }), persisted);
    expect(registry.list()).toEqual([]);
    expect(registry.resolve('off__y')?.upstream.record.enabled).toBe(false);
  });

  it('hides tools whose stored state is not active', () => {
    const { registry } = setup({ fx: { tools: ['get_info', 'convert'] } });
    registry.apply(record('fx'));
    registry.setToolStates('id-fx', new Map([['get_info', 'changed']]));
    expect(registry.list().map((t) => t.name)).toEqual(['fx__convert']);
    expect(registry.resolve('fx__get_info')).toBeUndefined();
  });

  it('keeps the first of two tools that sanitize to one exposed name', () => {
    const log = captureLog();
    const { registry } = setup({ main: { tools: ['get_info', 'get.info'] } }, { log });
    registry.apply(record('main'));
    expect(registry.list().map((t) => t.name)).toEqual(['main__get_info']);
    expect(registry.resolve('main__get_info')?.toolName).toBe('get.info');
    expect(log.lines.join('\n')).toContain('exposed name collision');
  });

  it('stops the old upstream when a server is reloaded', () => {
    const { registry, fakes } = setup({ fx: { tools: ['a'] } });
    registry.apply(record('fx'));
    const first = fakes.get('fx')!;
    registry.apply(record('fx', { name: 'FX 2' }));
    expect(first.stopped).toBe(true);
    expect(fakes.get('fx')!.started).toBe(true);
    expect(registry.list()[0]?.description).toBe('[FX 2] does a');
  });

  it('drops a removed server', async () => {
    const { registry } = setup({ fx: { tools: ['a'] } });
    registry.apply(record('fx'));
    await registry.remove('id-fx');
    expect(registry.list()).toEqual([]);
    expect(registry.resolve('fx__a')).toBeUndefined();
    expect(registry.ids()).toEqual([]);
  });

  it('follows tool changes from the upstream and reports them', () => {
    const onTools = vi.fn();
    const { registry, fakes } = setup({ fx: { tools: ['a'] } }, { onTools });
    registry.apply(record('fx'));
    fakes.get('fx')!.setTools(['a', 'b']);
    expect(registry.list().map((t) => t.name)).toEqual(['fx__a', 'fx__b']);
    expect(onTools).toHaveBeenCalledTimes(1);
  });

  it('reports a disabled server status when it is applied', () => {
    const onStatus = vi.fn();
    const { registry } = setup({}, { onStatus });
    registry.apply(record('off', { enabled: false }));
    expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({ state: 'disabled' }), true);
  });
});
