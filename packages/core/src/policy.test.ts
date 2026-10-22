import { describe, expect, it } from 'vitest';
import {
  SEED_POLICIES,
  evaluatePolicy,
  globMatch,
  policyRuleInput,
  sortRules,
  type PolicyRule,
} from './policy.js';

let n = 0;
const rule = (over: Partial<PolicyRule>): PolicyRule => {
  n += 1;
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    role: 'member',
    serverPattern: '*',
    toolPattern: '*',
    effect: 'allow',
    priority: 0,
    createdAt: new Date(2026, 0, 1, 0, 0, n),
    ...over,
  };
};

const seeded = (): PolicyRule[] => SEED_POLICIES.map((r) => rule(r));

describe('globMatch', () => {
  it('matches * against any run including empty', () => {
    expect(globMatch('list_*', 'list_')).toBe(true);
    expect(globMatch('list_*', 'list_orders')).toBe(true);
    expect(globMatch('*', '')).toBe(true);
    expect(globMatch('a*c*e', 'abcde')).toBe(true);
  });

  it('treats regex characters as literal', () => {
    expect(globMatch('a.b', 'a.b')).toBe(true);
    expect(globMatch('a.b', 'aXb')).toBe(false);
    expect(globMatch('a+b', 'aab')).toBe(false);
    expect(globMatch('(x)', '(x)')).toBe(true);
  });

  it('anchors both ends', () => {
    expect(globMatch('list', 'list_orders')).toBe(false);
    expect(globMatch('orders', 'list_orders')).toBe(false);
    expect(globMatch('*orders', 'list_orders')).toBe(true);
  });

  it('is case-sensitive', () => {
    expect(globMatch('list_*', 'LIST_orders')).toBe(false);
  });
});

describe('evaluatePolicy', () => {
  it('lets the highest priority decide', () => {
    const rules = [
      rule({ serverPattern: 'main', toolPattern: '*', effect: 'allow', priority: 1 }),
      rule({ serverPattern: 'main', toolPattern: '*', effect: 'deny', priority: 5 }),
    ];
    expect(evaluatePolicy(rules, 'member', 'main', 'list_orders')).toBe(false);
  });

  it('lets deny win a tie at equal priority', () => {
    const allow = rule({ effect: 'allow', createdAt: new Date(2026, 0, 1) });
    const deny = rule({ effect: 'deny', createdAt: new Date(2026, 0, 2) });
    expect(evaluatePolicy([allow, deny], 'member', 'main', 'x')).toBe(false);
    expect(evaluatePolicy([deny, allow], 'member', 'main', 'x')).toBe(false);
  });

  it('puts the older rule first when priority and effect are equal', () => {
    const older = rule({ createdAt: new Date(2026, 0, 1) });
    const newer = rule({ createdAt: new Date(2026, 0, 2) });
    expect(sortRules([newer, older]).map((r) => r.id)).toEqual([older.id, newer.id]);
  });

  it('breaks the last tie by id', () => {
    const at = new Date(2026, 0, 1);
    const b = rule({ id: '00000000-0000-4000-8000-00000000000b', createdAt: at });
    const a = rule({ id: '00000000-0000-4000-8000-00000000000a', createdAt: at });
    expect(sortRules([b, a]).map((r) => r.id)).toEqual([a.id, b.id]);
  });

  it('does not reorder the input array', () => {
    const rules = [rule({ priority: 0 }), rule({ priority: 9 })];
    const copy = [...rules];
    sortRules(rules);
    expect(rules).toEqual(copy);
  });

  it('ignores rules of the other role', () => {
    const rules = [rule({ role: 'admin', effect: 'allow' })];
    expect(evaluatePolicy(rules, 'member', 'main', 'x')).toBe(false);
  });

  it('allows admin and denies member when nothing matches', () => {
    expect(evaluatePolicy([], 'admin', 'main', 'x')).toBe(true);
    expect(evaluatePolicy([], 'member', 'main', 'x')).toBe(false);
  });

  it('applies the seeded member rules', () => {
    const rules = seeded();
    for (const [s, t] of [
      ['main', 'list_orders'],
      ['main', 'get_order'],
      ['fx', 'convert_currency'],
      ['gh', 'search_code'],
      ['gh', 'list_issues'],
    ] as const) {
      expect(evaluatePolicy(rules, 'member', s, t), `${s}/${t}`).toBe(true);
    }
    for (const [s, t] of [
      ['main', 'create_product'],
      ['gh', 'create_issue'],
      ['main', 'update_order'],
    ] as const) {
      expect(evaluatePolicy(rules, 'member', s, t), `${s}/${t}`).toBe(false);
    }
  });

  it('applies the seeded admin rule to everything', () => {
    const rules = seeded();
    expect(evaluatePolicy(rules, 'admin', 'main', 'create_product')).toBe(true);
    expect(evaluatePolicy(rules, 'admin', 'gh', 'create_issue')).toBe(true);
  });

  it('seeds the seven default tool permission rules at priority 0', () => {
    expect(SEED_POLICIES).toHaveLength(7);
    expect(SEED_POLICIES.every((r) => r.priority === 0 && r.effect === 'allow')).toBe(true);
    for (const r of SEED_POLICIES) expect(policyRuleInput.safeParse(r).success).toBe(true);
  });
});

describe('policyRuleInput', () => {
  const ok = { role: 'member', serverPattern: 'main', toolPattern: 'list_*', effect: 'deny' };

  it('accepts a valid rule and defaults priority to 0', () => {
    const parsed = policyRuleInput.parse(ok);
    expect(parsed.priority).toBe(0);
  });

  it.each([
    ['empty server pattern', { serverPattern: '' }],
    ['empty tool pattern', { toolPattern: '' }],
    ['space in server pattern', { serverPattern: 'a b' }],
    ['space in tool pattern', { toolPattern: 'list orders' }],
    ['upper case server pattern', { serverPattern: 'Main' }],
    ['server pattern of 25 characters', { serverPattern: 'a'.repeat(25) }],
    ['tool pattern of 129 characters', { toolPattern: 'a'.repeat(129) }],
    ['priority 1001', { priority: 1001 }],
    ['priority -1001', { priority: -1001 }],
    ['fractional priority', { priority: 1.5 }],
    ['unknown role', { role: 'owner' }],
    ['unknown effect', { effect: 'maybe' }],
  ])('rejects %s', (_name, over) => {
    expect(policyRuleInput.safeParse({ ...ok, ...over }).success).toBe(false);
  });

  it('accepts the edges: 24 and 128 characters, priority -1000 and 1000', () => {
    expect(
      policyRuleInput.safeParse({
        ...ok,
        serverPattern: 'a'.repeat(24),
        toolPattern: 'a'.repeat(128),
        priority: 1000,
      }).success,
    ).toBe(true);
    expect(policyRuleInput.safeParse({ ...ok, priority: -1000 }).success).toBe(true);
  });
});
