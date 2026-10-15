import type { Tool } from '@modelcontextprotocol/client';
import { describeTool, exposedToolName } from '@woo/core';
import type { Log, PersistedTool, ServerRecord, ToolState } from './types.js';
import { Upstream, type UpstreamOptions } from './upstream.js';

export type Route = {
  upstream: Pick<Upstream, 'record' | 'call'>;
  toolName: string;
};

// Called with the server slug and the upstream's own tool name, not the exposed name.
export type ToolFilter = (serverSlug: string, toolName: string) => boolean;

export interface Router {
  list(keep?: ToolFilter): Tool[];
  resolve(exposedName: string): Route | undefined;
}

export type RegistryOptions = {
  log: Log;
  upstream?: Omit<UpstreamOptions, 'log' | 'onTools' | 'onStatus'>;
  onTools?: (u: Upstream) => void;
  onStatus?: (u: Upstream, changed: boolean) => void;
  createUpstream?: (record: ServerRecord, o: UpstreamOptions) => Upstream;
};

type Entry = { upstream: Upstream; persisted: PersistedTool[]; states: Map<string, ToolState> };

const byName = (a: { name: string }, b: { name: string }) =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

export class Registry implements Router {
  private readonly entries = new Map<string, Entry>();
  private routes = new Map<string, { serverId: string; toolName: string }>();

  constructor(private readonly o: RegistryOptions) {}

  apply(record: ServerRecord, persisted: PersistedTool[] = []): void {
    const old = this.entries.get(record.id);
    if (old) void old.upstream.stop();
    const current = (u: Upstream) => this.entries.get(record.id)?.upstream === u;
    const opts: UpstreamOptions = {
      ...this.o.upstream,
      log: this.o.log,
      onTools: (u) => {
        if (!current(u)) return;
        this.rebuild();
        this.o.onTools?.(u);
      },
      onStatus: (u, changed) => {
        if (current(u)) this.o.onStatus?.(u, changed);
      },
    };
    const upstream = this.o.createUpstream
      ? this.o.createUpstream(record, opts)
      : new Upstream(record, opts);
    this.entries.set(record.id, {
      upstream,
      persisted,
      states: new Map(persisted.map((p) => [p.name, p.state])),
    });
    this.rebuild();
    // A disabled server never connects, so nothing else would report its status.
    if (!record.enabled) this.o.onStatus?.(upstream, true);
    upstream.start();
  }

  async remove(serverId: string): Promise<void> {
    const entry = this.entries.get(serverId);
    if (!entry) return;
    this.entries.delete(serverId);
    this.rebuild();
    await entry.upstream.stop();
  }

  setToolStates(serverId: string, states: Map<string, ToolState>): void {
    const entry = this.entries.get(serverId);
    if (entry) entry.states = states;
  }

  ids(): string[] {
    return [...this.entries.keys()];
  }

  upstreams(): Upstream[] {
    return [...this.entries.values()].map((e) => e.upstream);
  }

  list(keep?: ToolFilter): Tool[] {
    const out: Tool[] = [];
    for (const [serverId, { upstream, states }] of this.entries) {
      const r = upstream.record;
      if (!r.enabled || r.approval !== 'approved' || upstream.state !== 'connected') continue;
      for (const t of upstream.tools()) {
        if ((states.get(t.name) ?? 'active') !== 'active') continue;
        if (keep && !keep(r.slug, t.name)) continue;
        const name = exposedToolName(r.slug, t.name);
        const route = this.routes.get(name);
        if (route?.serverId !== serverId || route.toolName !== t.name) continue;
        out.push({ ...t, name, description: describeTool(r, t.description) });
      }
    }
    return out.sort(byName);
  }

  resolve(exposedName: string): Route | undefined {
    const hit = this.routes.get(exposedName);
    const entry = hit ? this.entries.get(hit.serverId) : undefined;
    if (!hit || !entry) return undefined;
    if (entry.upstream.record.approval !== 'approved') return undefined;
    if ((entry.states.get(hit.toolName) ?? 'active') !== 'active') return undefined;
    return { upstream: entry.upstream, toolName: hit.toolName };
  }

  async close(): Promise<void> {
    const all = [...this.entries.values()];
    this.entries.clear();
    this.routes = new Map();
    await Promise.all(all.map((e) => e.upstream.stop()));
  }

  // Live tools when the upstream has answered on this replica, else the names persisted in mcp_tools,
  // so a call to a disabled or unreachable server gets a clear error instead of "Unknown tool".
  private rebuild(): void {
    const routes = new Map<string, { serverId: string; toolName: string }>();
    for (const [serverId, { upstream, persisted }] of this.entries) {
      const live = upstream.tools();
      const names = (
        live.length > 0 ? live.map((t) => t.name) : persisted.map((p) => p.name)
      ).sort();
      for (const toolName of names) {
        const exposed = exposedToolName(upstream.record.slug, toolName);
        const taken = routes.get(exposed);
        if (taken) {
          this.o.log.warn(
            { server: upstream.record.slug, tool: toolName, exposed, kept: taken.toolName },
            'exposed name collision, tool skipped',
          );
          continue;
        }
        routes.set(exposed, { serverId, toolName });
      }
    }
    this.routes = routes;
  }
}
