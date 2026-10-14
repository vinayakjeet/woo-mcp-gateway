import { evaluatePolicy, type PolicyRole, type PolicyRule } from '@woo/core';
import { schema } from '@woo/core/db';
import type { Db } from './types.js';

export interface PolicyView {
  allows(role: PolicyRole, serverSlug: string, toolName: string): boolean;
}

// Rules live in memory so tools/list never waits on Postgres. Before the first load the list is
// empty, which hides everything from members (the SPEC 8 default).
export class PolicyStore implements PolicyView {
  private rules: PolicyRule[] = [];

  constructor(private readonly db: Db) {}

  async load(): Promise<void> {
    const rows = await this.db
      .select({
        id: schema.toolPolicies.id,
        role: schema.toolPolicies.role,
        serverPattern: schema.toolPolicies.serverPattern,
        toolPattern: schema.toolPolicies.toolPattern,
        effect: schema.toolPolicies.effect,
        priority: schema.toolPolicies.priority,
        createdAt: schema.toolPolicies.createdAt,
      })
      .from(schema.toolPolicies);
    this.rules = rows;
  }

  allows(role: PolicyRole, serverSlug: string, toolName: string): boolean {
    return evaluatePolicy(this.rules, role, serverSlug, toolName);
  }
}
