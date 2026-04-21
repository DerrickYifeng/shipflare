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
  };
});

vi.mock('@/lib/db/schema', () => ({
  teams: teamsTable,
  teamMembers: teamMembersTable,
  products: productsTable,
  channels: channelsTable,
}));

vi.mock('@/lib/db', () => {
  interface EqSentinel {
    __eq: { col: unknown; value: unknown };
  }
  interface AndSentinel {
    __and: EqSentinel[];
  }
  function flattenFilters(cond: unknown): Array<[unknown, unknown]> {
    if (!cond) return [];
    const c = cond as EqSentinel | AndSentinel;
    if ('__and' in c) {
      return c.__and.flatMap((x) => flattenFilters(x));
    }
    if ('__eq' in c) return [[c.__eq.col, c.__eq.value]];
    return [];
  }

  function matches(row: Record<string, unknown>, filters: Array<[unknown, unknown]>): boolean {
    return filters.every(([col, value]) => {
      // `col` here is whatever drizzle column ref the test receives. For this
      // mock we treat the source.column as the symbol + name pair, but
      // dranzle's column refs include a table reference. We decode col name
      // from symbol-assigned debug. To keep this simple, we assume filters
      // are always against the primary join key for each table and just
      // fall through to comparing by-key.
      void col;
      void value;
      return true;
    });
  }

  // A lightweight row-matcher that introspects the columns selected by
  // checking if `value` equals any of the row's fields.
  function rowMatches(row: Record<string, unknown>, filters: Array<[unknown, unknown]>): boolean {
    // Every filter value must appear as a field in the row.
    return filters.every(([_col, value]) => {
      return Object.values(row).some((v) => v === value);
    });
  }
  void matches;

  function selectBuilder() {
    return {
      from: (table: TableKey) => ({
        // .where() must be both awaitable (for callers that don't chain
        // .limit) AND carry a .limit() method. Return a thenable-ish object.
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
  it('always includes the 3 baseline agents', async () => {
    const { getTeamCompositionForPreset } = await import(
      '@/lib/team-provisioner'
    );
    const baseline: AgentType[] = ['coordinator', 'growth-strategist', 'content-planner'];
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

  it('dev-squad: base + x-writer + community-manager', async () => {
    const { getTeamCompositionForPreset } = await import(
      '@/lib/team-provisioner'
    );
    expect(getTeamCompositionForPreset('dev-squad')).toEqual([
      'coordinator',
      'growth-strategist',
      'content-planner',
      'x-writer',
      'community-manager',
    ]);
  });

  it('saas-squad: base + x-writer + community-manager', async () => {
    const { getTeamCompositionForPreset } = await import(
      '@/lib/team-provisioner'
    );
    expect(getTeamCompositionForPreset('saas-squad')).toEqual([
      'coordinator',
      'growth-strategist',
      'content-planner',
      'x-writer',
      'community-manager',
    ]);
  });

  it('consumer-squad: base + reddit-writer + community-manager', async () => {
    const { getTeamCompositionForPreset } = await import(
      '@/lib/team-provisioner'
    );
    expect(getTeamCompositionForPreset('consumer-squad')).toEqual([
      'coordinator',
      'growth-strategist',
      'content-planner',
      'reddit-writer',
      'community-manager',
    ]);
  });

  it('default-squad: base + x-writer', async () => {
    const { getTeamCompositionForPreset } = await import(
      '@/lib/team-provisioner'
    );
    expect(getTeamCompositionForPreset('default-squad')).toEqual([
      'coordinator',
      'growth-strategist',
      'content-planner',
      'x-writer',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Integration tests — ensureTeamExists / provisionTeamForProduct
// ---------------------------------------------------------------------------

describe('ensureTeamExists (baseline, no preset)', () => {
  beforeEach(() => resetTables());

  it('creates a new team with the 3 baseline members on first call', async () => {
    const { ensureTeamExists } = await import('@/lib/team-provisioner');
    const res = await ensureTeamExists('u-1', 'p-1');
    expect(res.created).toBe(true);
    expect(res.teamId).toBeTruthy();
    expect(res.memberIds.coordinator).toBeTruthy();
    expect(res.memberIds['growth-strategist']).toBeTruthy();
    expect(res.memberIds['content-planner']).toBeTruthy();

    const members = getTeamMembers();
    expect(members).toHaveLength(3);
    const types = new Set(members.map((m) => m.agentType));
    expect(types).toEqual(
      new Set(['coordinator', 'growth-strategist', 'content-planner']),
    );
  });

  it('is idempotent — second call returns same teamId, no new inserts', async () => {
    const { ensureTeamExists } = await import('@/lib/team-provisioner');
    const first = await ensureTeamExists('u-1', 'p-1');
    const second = await ensureTeamExists('u-1', 'p-1');
    expect(first.teamId).toBe(second.teamId);
    expect(first.memberIds).toEqual(second.memberIds);
    expect(second.created).toBe(false);
    expect(getTeamMembers()).toHaveLength(3);
  });
});

describe('ensureTeamExists (with preset)', () => {
  beforeEach(() => resetTables());

  it('dev-squad preset seeds 5 members on a fresh team', async () => {
    const { ensureTeamExists } = await import('@/lib/team-provisioner');
    const res = await ensureTeamExists('u-1', 'p-1', { preset: 'dev-squad' });
    expect(res.created).toBe(true);
    expect(getTeamMembers()).toHaveLength(5);
    const types = new Set(getTeamMembers().map((m) => m.agentType));
    expect(types).toEqual(
      new Set([
        'coordinator',
        'growth-strategist',
        'content-planner',
        'x-writer',
        'community-manager',
      ]),
    );
  });

  it('reconciles — adding preset on an existing baseline team inserts the delta', async () => {
    const { ensureTeamExists } = await import('@/lib/team-provisioner');
    await ensureTeamExists('u-1', 'p-1'); // baseline: 3 members
    expect(getTeamMembers()).toHaveLength(3);

    // Now a channel connects and we re-run with the consumer-squad preset.
    await ensureTeamExists('u-1', 'p-1', { preset: 'consumer-squad' });
    expect(getTeamMembers()).toHaveLength(5);
    const types = new Set(getTeamMembers().map((m) => m.agentType));
    expect(types).toEqual(
      new Set([
        'coordinator',
        'growth-strategist',
        'content-planner',
        'reddit-writer',
        'community-manager',
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
    expect(nameByType['growth-strategist']).toBe('Head of Growth');
    expect(nameByType['content-planner']).toBe('Head of Content');
    expect(nameByType['x-writer']).toBe('X Writer');
    expect(nameByType['community-manager']).toBe('Community Manager');
  });
});

describe('provisionTeamForProduct', () => {
  beforeEach(() => resetTables());

  it('dev_tool category + X channel connected → dev-squad with 5 members', async () => {
    rows[productsTable].push({ id: 'p-1', userId: 'u-1', category: 'dev_tool' });
    rows[channelsTable].push({ id: 'c-1', userId: 'u-1', platform: 'x' });
    const { provisionTeamForProduct } = await import('@/lib/team-provisioner');
    const res = await provisionTeamForProduct('u-1', 'p-1');
    expect(res.preset).toBe('dev-squad');
    expect(res.roster).toEqual([
      'coordinator',
      'growth-strategist',
      'content-planner',
      'x-writer',
      'community-manager',
    ]);
    expect(getTeamMembers()).toHaveLength(5);
  });

  it('consumer category + no reddit channel → falls back so we do not seed dead reddit-writer', async () => {
    rows[productsTable].push({ id: 'p-1', userId: 'u-1', category: 'consumer' });
    rows[channelsTable].push({ id: 'c-1', userId: 'u-1', platform: 'x' });
    // No reddit channel connected.
    const { provisionTeamForProduct } = await import('@/lib/team-provisioner');
    const res = await provisionTeamForProduct('u-1', 'p-1');
    // Fallback (hasX=true, hasReddit=false) → saas-squad composition.
    expect(res.preset).toBe('saas-squad');
    const types = new Set(getTeamMembers().map((m) => m.agentType));
    expect(types).not.toContain('reddit-writer');
    expect(types).toContain('x-writer');
  });

  it('consumer category + reddit channel connected → consumer-squad seeds reddit-writer', async () => {
    rows[productsTable].push({ id: 'p-1', userId: 'u-1', category: 'consumer' });
    rows[channelsTable].push({ id: 'c-1', userId: 'u-1', platform: 'reddit' });
    const { provisionTeamForProduct } = await import('@/lib/team-provisioner');
    const res = await provisionTeamForProduct('u-1', 'p-1');
    expect(res.preset).toBe('consumer-squad');
    const types = new Set(getTeamMembers().map((m) => m.agentType));
    expect(types).toContain('reddit-writer');
    expect(types).toContain('community-manager');
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
        'growth-strategist',
        'content-planner',
        'x-writer',
      ]),
    );
  });

  it('reconciles when a new channel connects after initial provisioning', async () => {
    rows[productsTable].push({ id: 'p-1', userId: 'u-1', category: 'consumer' });
    rows[channelsTable].push({ id: 'c-1', userId: 'u-1', platform: 'x' });
    const { provisionTeamForProduct } = await import('@/lib/team-provisioner');

    // Initial run: no reddit → falls back to saas-squad (x-writer + cm).
    await provisionTeamForProduct('u-1', 'p-1');
    expect(
      new Set(getTeamMembers().map((m) => m.agentType)),
    ).not.toContain('reddit-writer');

    // User connects reddit, re-run.
    rows[channelsTable].push({ id: 'c-2', userId: 'u-1', platform: 'reddit' });
    const second = await provisionTeamForProduct('u-1', 'p-1');
    expect(second.preset).toBe('consumer-squad');
    const types = new Set(getTeamMembers().map((m) => m.agentType));
    expect(types).toContain('reddit-writer');
    expect(types).toContain('x-writer'); // existing members preserved
    expect(types).toContain('community-manager');
    // Baseline 3 still present.
    expect(types).toContain('coordinator');
  });

  it('productId=null → provisions a product-less default-squad', async () => {
    const { provisionTeamForProduct } = await import('@/lib/team-provisioner');
    const res = await provisionTeamForProduct('u-1', null);
    expect(res.preset).toBe('default-squad');
    expect(getTeams()).toHaveLength(1);
    expect(getTeams()[0].productId).toBeNull();
  });
});
