import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  AgentType,
  ProductCategory,
  TeamPreset,
} from '@/lib/team-provisioner';

// ---------------------------------------------------------------------------
// In-memory Drizzle-ish mock. Covers the tiny slice of drizzle-orm the
// provisioner actually uses: .select().from().where().limit() and
// .insert().values(). Each table is keyed by its identity — the test seeds
// `products`/`channels` rows + reads back `teams`/`team_members` state.
// ---------------------------------------------------------------------------

interface ProductRow {
  id: string;
  userId: string;
  category: string | null;
}
interface ChannelRow {
  id: string;
  userId: string;
  platform: string;
}
interface TeamRow {
  id: string;
  userId: string;
  productId: string | null;
  name: string;
  config: Record<string, unknown>;
}
interface TeamMemberRow {
  id: string;
  teamId: string;
  agentType: string;
  displayName: string;
  status: string;
}

const productsTable: symbol = Symbol('products');
const channelsTable: symbol = Symbol('channels');
const teamsTable: symbol = Symbol('teams');
const teamMembersTable: symbol = Symbol('teamMembers');
type TableKey = symbol;

// Typed any[] per symbol key so the mock can index without narrowing by key.
// Each test casts to the expected row shape when reading.
const rows: Record<symbol, unknown[]> = {
  [productsTable]: [] as ProductRow[],
  [channelsTable]: [] as ChannelRow[],
  [teamsTable]: [] as TeamRow[],
  [teamMembersTable]: [] as TeamMemberRow[],
};

function resetTables() {
  rows[productsTable].length = 0;
  rows[channelsTable].length = 0;
  rows[teamsTable].length = 0;
  rows[teamMembersTable].length = 0;
}

// Narrow typed accessors — read-only views so each test doesn't have to
// inline the cast.
const getTeamMembers = (): TeamMemberRow[] =>
  rows[teamMembersTable] as TeamMemberRow[];
const getTeams = (): TeamRow[] => rows[teamsTable] as TeamRow[];

// drizzle-orm mocks — match on a small number of well-known calling shapes
// rather than implementing a full filter evaluator.
vi.mock('drizzle-orm', async () => {
  const actual =
    await vi.importActual<typeof import('drizzle-orm')>('drizzle-orm');
  return {
    ...actual,
    eq: (col: unknown, value: unknown) => ({ __eq: { col, value } }),
    and: (...parts: unknown[]) => ({ __and: parts }),
    isNull: (col: unknown) => ({ __isNull: col }),
  };
});

vi.mock('@/lib/db/schema', () => ({
  teams: teamsTable,
  teamMembers: teamMembersTable,
  products: productsTable,
  channels: channelsTable,
}));

vi.mock('@/lib/db', () => {
  interface EqSentinel { __eq: { col: unknown; value: unknown } }
  interface AndSentinel { __and: unknown[] }
  interface IsNullSentinel { __isNull: unknown }
  type Filter =
    | { kind: 'eq'; value: unknown }
    | { kind: 'isNull' };

  function flattenFilters(cond: unknown): Filter[] {
    if (!cond) return [];
    if ((cond as AndSentinel).__and) {
      return (cond as AndSentinel).__and.flatMap((x) => flattenFilters(x));
    }
    if ((cond as EqSentinel).__eq) {
      return [{ kind: 'eq', value: (cond as EqSentinel).__eq.value }];
    }
    if ((cond as IsNullSentinel).__isNull !== undefined) {
      return [{ kind: 'isNull' }];
    }
    return [];
  }

  // Heuristic row-matcher: eq filter matches when the value appears as any
  // field in the row; isNull filter matches when the row has at least one
  // null or undefined field. Not a real query planner, but sufficient for
  // the provisioner's shape (all filters target (user_id, product_id) or
  // (id, agent_type)).
  function rowMatches(
    row: Record<string, unknown>,
    filters: Filter[],
  ): boolean {
    return filters.every((f) => {
      if (f.kind === 'eq') {
        return Object.values(row).some((v) => v === f.value);
      }
      return Object.values(row).some((v) => v === null || v === undefined);
    });
  }

  function selectBuilder() {
    return {
      from: (table: TableKey) => ({
        where: (cond: unknown) => {
          const filters = flattenFilters(cond);
          const result = rows[table].filter((r) =>
            rowMatches(r as Record<string, unknown>, filters),
          );
          const withLimit = {
            limit: (_n: number) => Promise.resolve(result.slice(0, _n)),
            then: (onFulfilled: (v: unknown) => unknown) =>
              Promise.resolve(result).then(onFulfilled),
          };
          return withLimit as unknown as Promise<unknown[]> & {
            limit: (n: number) => Promise<unknown[]>;
          };
        },
      }),
    };
  }

  return {
    db: {
      select: () => selectBuilder(),
      insert: (table: TableKey) => ({
        values: (v: Record<string, unknown>) => {
          rows[table].push(v as never);
          return Promise.resolve([]);
        },
      }),
      update: (table: TableKey) => ({
        set: (patch: Record<string, unknown>) => ({
          where: (cond: unknown) => {
            const filters = flattenFilters(cond);
            const list = rows[table] as Record<string, unknown>[];
            for (let i = 0; i < list.length; i += 1) {
              if (rowMatches(list[i], filters)) {
                list[i] = { ...list[i], ...patch };
              }
            }
            return Promise.resolve([]);
          },
        }),
      }),
    },
  };
});

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
}));

// ---------------------------------------------------------------------------
// Unit tests — pure helpers
// ---------------------------------------------------------------------------

describe('pickPresetByCategory', () => {
  it('maps each category to the right preset', async () => {
    const { pickPresetByCategory } = await import('@/lib/team-provisioner');
    const cases: Array<[ProductCategory | null | undefined, TeamPreset]> = [
      ['dev_tool', 'dev-squad'],
      ['saas', 'saas-squad'],
      ['ai_app', 'saas-squad'],
      ['consumer', 'consumer-squad'],
      ['creator_tool', 'default-squad'],
      ['agency', 'default-squad'],
      ['other', 'default-squad'],
      [null, 'default-squad'],
      [undefined, 'default-squad'],
    ];
    for (const [cat, preset] of cases) {
      expect(pickPresetByCategory(cat)).toBe(preset);
    }
  });
});

describe('getTeamCompositionForPreset', () => {
  it('always includes the 2 baseline agents', async () => {
    const { getTeamCompositionForPreset } = await import(
      '@/lib/team-provisioner'
    );
    // Phase F dropped `growth-strategist` from the baseline — the
    // strategic-path generator is now the `generating-strategy`
    // fork-mode skill, not a team member.
    const baseline: AgentType[] = ['coordinator', 'content-planner'];
    for (const preset of [
      'dev-squad',
      'saas-squad',
      'consumer-squad',
      'default-squad',
    ] as TeamPreset[]) {
      const roster = getTeamCompositionForPreset(preset);
      for (const role of baseline) expect(roster).toContain(role);
    }
  });

  it('dev-squad: base + post-writer + content-manager', async () => {
    const { getTeamCompositionForPreset } = await import(
      '@/lib/team-provisioner'
    );
    expect(getTeamCompositionForPreset('dev-squad')).toEqual([
      'coordinator',
      'content-planner',
      'post-writer',
      'content-manager',
    ]);
  });

  it('saas-squad: base + post-writer + content-manager', async () => {
    const { getTeamCompositionForPreset } = await import(
      '@/lib/team-provisioner'
    );
    expect(getTeamCompositionForPreset('saas-squad')).toEqual([
      'coordinator',
      'content-planner',
      'post-writer',
      'content-manager',
    ]);
  });

  it('consumer-squad: base + post-writer + content-manager', async () => {
    const { getTeamCompositionForPreset } = await import(
      '@/lib/team-provisioner'
    );
    expect(getTeamCompositionForPreset('consumer-squad')).toEqual([
      'coordinator',
      'content-planner',
      'post-writer',
      'content-manager',
    ]);
  });

  it('default-squad: base + post-writer', async () => {
    const { getTeamCompositionForPreset } = await import(
      '@/lib/team-provisioner'
    );
    expect(getTeamCompositionForPreset('default-squad')).toEqual([
      'coordinator',
      'content-planner',
      'post-writer',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Integration tests — ensureTeamExists / provisionTeamForProduct
// ---------------------------------------------------------------------------

describe('ensureTeamExists (baseline, no preset)', () => {
  beforeEach(() => resetTables());

  it('creates a new team with the 2 baseline members on first call', async () => {
    const { ensureTeamExists } = await import('@/lib/team-provisioner');
    const res = await ensureTeamExists('u-1', 'p-1');
    expect(res.created).toBe(true);
    expect(res.teamId).toBeTruthy();
    expect(res.memberIds.coordinator).toBeTruthy();
    expect(res.memberIds['content-planner']).toBeTruthy();

    const members = getTeamMembers();
    expect(members).toHaveLength(2);
    const types = new Set(members.map((m) => m.agentType));
    expect(types).toEqual(
      new Set([
        'coordinator',
        'content-planner',
      ]),
    );
  });

  it('is idempotent — second call returns same teamId, no new inserts', async () => {
    const { ensureTeamExists } = await import('@/lib/team-provisioner');
    const first = await ensureTeamExists('u-1', 'p-1');
    const second = await ensureTeamExists('u-1', 'p-1');
    expect(first.teamId).toBe(second.teamId);
    expect(first.memberIds).toEqual(second.memberIds);
    expect(second.created).toBe(false);
    expect(getTeamMembers()).toHaveLength(2);
  });
});

describe('ensureTeamExists (with preset)', () => {
  beforeEach(() => resetTables());

  it('dev-squad preset seeds 4 members on a fresh team', async () => {
    const { ensureTeamExists } = await import('@/lib/team-provisioner');
    const res = await ensureTeamExists('u-1', 'p-1', { preset: 'dev-squad' });
    expect(res.created).toBe(true);
    expect(getTeamMembers()).toHaveLength(4);
    const types = new Set(getTeamMembers().map((m) => m.agentType));
    expect(types).toEqual(
      new Set([
        'coordinator',
        'content-planner',
        'post-writer',
        'content-manager',
      ]),
    );
  });

  it('reconciles — adding preset on an existing baseline team inserts the delta', async () => {
    const { ensureTeamExists } = await import('@/lib/team-provisioner');
    await ensureTeamExists('u-1', 'p-1'); // baseline: 2 members
    expect(getTeamMembers()).toHaveLength(2);

    // Now a channel connects and we re-run with the consumer-squad preset.
    await ensureTeamExists('u-1', 'p-1', { preset: 'consumer-squad' });
    expect(getTeamMembers()).toHaveLength(4);
    const types = new Set(getTeamMembers().map((m) => m.agentType));
    expect(types).toEqual(
      new Set([
        'coordinator',
        'content-planner',
        'post-writer',
        'content-manager',
      ]),
    );
  });

  it('display names use the role labels from DEFAULT_DISPLAY_NAMES', async () => {
    const { ensureTeamExists } = await import('@/lib/team-provisioner');
    await ensureTeamExists('u-1', 'p-1', { preset: 'dev-squad' });
    const nameByType = Object.fromEntries(
      getTeamMembers().map((m) => [m.agentType, m.displayName]),
    );
    expect(nameByType['coordinator']).toBe('Chief of Staff');
    expect(nameByType['content-planner']).toBe('Head of Content');
    expect(nameByType['post-writer']).toBe('Post Writer');
    expect(nameByType['content-manager']).toBe('Community Manager');
  });
});

describe('provisionTeamForProduct', () => {
  beforeEach(() => resetTables());

  it('dev_tool category + X channel connected → dev-squad with 4 members', async () => {
    rows[productsTable].push({ id: 'p-1', userId: 'u-1', category: 'dev_tool' });
    rows[channelsTable].push({ id: 'c-1', userId: 'u-1', platform: 'x' });
    const { provisionTeamForProduct } = await import('@/lib/team-provisioner');
    const res = await provisionTeamForProduct('u-1', 'p-1');
    expect(res.preset).toBe('dev-squad');
    expect(res.roster).toEqual([
      'coordinator',
      'content-planner',
      'post-writer',
      'content-manager',
    ]);
    expect(getTeamMembers()).toHaveLength(4);
  });

  it('consumer category + only X connected → still consumer-squad (post-writer is channel-agnostic)', async () => {
    rows[productsTable].push({ id: 'p-1', userId: 'u-1', category: 'consumer' });
    rows[channelsTable].push({ id: 'c-1', userId: 'u-1', platform: 'x' });
    // No reddit channel connected, but post-writer covers X just as well —
    // the channel comes in via plan_items.channel.
    const { provisionTeamForProduct } = await import('@/lib/team-provisioner');
    const res = await provisionTeamForProduct('u-1', 'p-1');
    expect(res.preset).toBe('consumer-squad');
    const types = new Set(getTeamMembers().map((m) => m.agentType));
    expect(types).toContain('post-writer');
    expect(types).toContain('content-manager');
  });

  it('consumer category + reddit channel connected → consumer-squad seeds post-writer + content-manager', async () => {
    rows[productsTable].push({ id: 'p-1', userId: 'u-1', category: 'consumer' });
    rows[channelsTable].push({ id: 'c-1', userId: 'u-1', platform: 'reddit' });
    const { provisionTeamForProduct } = await import('@/lib/team-provisioner');
    const res = await provisionTeamForProduct('u-1', 'p-1');
    expect(res.preset).toBe('consumer-squad');
    const types = new Set(getTeamMembers().map((m) => m.agentType));
    expect(types).toContain('post-writer');
    expect(types).toContain('content-manager');
  });

  it('no channels connected → falls back to default-squad even for dev_tool', async () => {
    rows[productsTable].push({ id: 'p-1', userId: 'u-1', category: 'dev_tool' });
    const { provisionTeamForProduct } = await import('@/lib/team-provisioner');
    const res = await provisionTeamForProduct('u-1', 'p-1');
    expect(res.preset).toBe('default-squad');
    const types = new Set(getTeamMembers().map((m) => m.agentType));
    expect(types).toEqual(
      new Set([
        'coordinator',
        'content-planner',
        'post-writer',
      ]),
    );
  });

  it('reconciles when a new channel connects after initial provisioning', async () => {
    rows[productsTable].push({ id: 'p-1', userId: 'u-1', category: 'consumer' });
    // No platform channels yet → falls back to default-squad (post-writer only,
    // no content-manager because there's no inbox to monitor).
    const { provisionTeamForProduct } = await import('@/lib/team-provisioner');
    await provisionTeamForProduct('u-1', 'p-1');
    expect(
      new Set(getTeamMembers().map((m) => m.agentType)),
    ).not.toContain('content-manager');

    // User connects X, re-run — full consumer-squad now seeds.
    rows[channelsTable].push({ id: 'c-1', userId: 'u-1', platform: 'x' });
    const second = await provisionTeamForProduct('u-1', 'p-1');
    expect(second.preset).toBe('consumer-squad');
    const types = new Set(getTeamMembers().map((m) => m.agentType));
    expect(types).toContain('post-writer'); // existing member preserved
    expect(types).toContain('content-manager');
    // Baseline still present.
    expect(types).toContain('coordinator');
  });

  it('productId=null → provisions a product-less default-squad', async () => {
    const { provisionTeamForProduct } = await import('@/lib/team-provisioner');
    const res = await provisionTeamForProduct('u-1', null);
    expect(res.preset).toBe('default-squad');
    expect(getTeams()).toHaveLength(1);
    expect(getTeams()[0].productId).toBeNull();
  });

  it('relinks an orphan product_id=null team when productId is later known', async () => {
    const { provisionTeamForProduct } = await import('@/lib/team-provisioner');

    // Step 1: seed a null-product team (simulates /api/onboarding/plan
    // provisioning before the product row existed).
    await provisionTeamForProduct('u-1', null);
    expect(getTeams()).toHaveLength(1);
    expect(getTeams()[0].productId).toBeNull();
    const orphanTeamId = getTeams()[0].id;

    // Step 2: the product is committed — /api/onboarding/commit re-runs
    // provisionTeamForProduct with the concrete productId. The existing
    // null-product team should be relinked; no second team created.
    rows[productsTable].push({
      id: 'p-1',
      userId: 'u-1',
      category: 'dev_tool',
    });
    const res = await provisionTeamForProduct('u-1', 'p-1');

    expect(getTeams()).toHaveLength(1);
    expect(getTeams()[0].id).toBe(orphanTeamId);
    expect(getTeams()[0].productId).toBe('p-1');
    expect(res.teamId).toBe(orphanTeamId);
  });
});
