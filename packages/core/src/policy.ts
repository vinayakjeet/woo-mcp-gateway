import { z } from 'zod';

export type PolicyRole = 'admin' | 'member';
export type PolicyEffect = 'allow' | 'deny';

export interface PolicyRule {
  id: string;
  role: PolicyRole;
  serverPattern: string;
  toolPattern: string;
  effect: PolicyEffect;
  priority: number;
  createdAt: Date;
}

const escapeRegex = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

const compiled = new Map<string, RegExp>();

// Patterns are admin input, so build the regex from escaped literals and only
// let `*` stand for "any run of characters".
export function globMatch(pattern: string, value: string): boolean {
  let re = compiled.get(pattern);
  if (!re) {
    re = new RegExp(`^${pattern.split('*').map(escapeRegex).join('[\\s\\S]*')}$`);
    if (compiled.size > 1000) compiled.clear();
    compiled.set(pattern, re);
  }
  return re.test(value);
}

export const policyRuleInput = z.object({
  role: z.enum(['admin', 'member']),
  serverPattern: z
    .string()
    .min(1)
    .max(24)
    .regex(/^[a-z0-9*-]+$/),
  toolPattern: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[\x21-\x7e]+$/),
  effect: z.enum(['allow', 'deny']),
  priority: z.number().int().min(-1000).max(1000).default(0),
});

export type PolicyRuleInput = z.infer<typeof policyRuleInput>;

// Priority first, then deny before allow, then the older rule, then id, so two
// gateway replicas and the dashboard always order the same rules the same way.
export function sortRules<T extends Pick<PolicyRule, 'id' | 'effect' | 'priority' | 'createdAt'>>(
  rules: readonly T[],
): T[] {
  return [...rules].sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority;
    if (a.effect !== b.effect) return a.effect === 'deny' ? -1 : 1;
    const t = a.createdAt.getTime() - b.createdAt.getTime();
    if (t !== 0) return t;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

export function evaluatePolicy(
  rules: readonly PolicyRule[],
  role: PolicyRole,
  serverSlug: string,
  toolName: string,
): boolean {
  for (const r of sortRules(rules)) {
    if (r.role !== role) continue;
    if (!globMatch(r.serverPattern, serverSlug)) continue;
    if (!globMatch(r.toolPattern, toolName)) continue;
    return r.effect === 'allow';
  }
  return role === 'admin';
}

export const SEED_POLICIES: readonly PolicyRuleInput[] = [
  { role: 'member', serverPattern: '*', toolPattern: 'list_*', effect: 'allow', priority: 0 },
  { role: 'member', serverPattern: '*', toolPattern: 'get_*', effect: 'allow', priority: 0 },
  { role: 'member', serverPattern: 'fx', toolPattern: '*', effect: 'allow', priority: 0 },
  { role: 'member', serverPattern: 'gh', toolPattern: 'list_*', effect: 'allow', priority: 0 },
  { role: 'member', serverPattern: 'gh', toolPattern: 'get_*', effect: 'allow', priority: 0 },
  { role: 'member', serverPattern: 'gh', toolPattern: 'search_*', effect: 'allow', priority: 0 },
  { role: 'admin', serverPattern: '*', toolPattern: '*', effect: 'allow', priority: 0 },
];
