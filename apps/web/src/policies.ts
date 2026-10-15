import type { Role, Server, Tool } from './types';

export type PreviewTool = Pick<Tool, 'exposedName' | 'description'> & { server: string };

// What a client with this role gets from tools/list: the roles column already holds the policy
// result, so this only adds the gateway's other conditions (server enabled, approved and
// connected, tool active).
export function previewTools(servers: Server[], role: Role): PreviewTool[] {
  const out: PreviewTool[] = [];
  for (const s of servers) {
    if (!s.enabled || s.approval !== 'approved' || s.status?.state !== 'connected') continue;
    for (const t of s.tools) {
      if (t.state !== 'active' || !t.roles.includes(role)) continue;
      out.push({ exposedName: t.exposedName, description: t.description, server: s.slug });
    }
  }
  return out.sort((a, b) =>
    a.exposedName < b.exposedName ? -1 : a.exposedName > b.exposedName ? 1 : 0,
  );
}
