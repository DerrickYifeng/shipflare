import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock the agent registry — `loadSystemPromptContext` resolves each
// team_member.agentType through `resolveAgent` so it can format a
// roster line per agent. Tests stub it per-case.
// ---------------------------------------------------------------------------
const resolveAgentMock = vi.hoisted(() => vi.fn());
vi.mock('@/tools/AgentTool/registry', () => ({
  resolveAgent: resolveAgentMock,
}));

import {
  loadSystemPromptContext,
  substitutePlaceholders,
  type SystemPromptContext,
} from '@/lib/team/system-prompt-context';

// ---------------------------------------------------------------------------
// Drizzle table stand-ins. The fake db's `from()` is keyed by reference
// equality on these objects — so production code calls `db.select().from(teams)`
// and the test's switch matches the same object. Each fake table object is
// shared between the mocked `@/lib/db/schema` module exports and the runtime
// db, which keeps the test independent of the real Drizzle column shapes.
//
// Use `vi.hoisted` because `vi.mock` factories are hoisted to the top of the
// file; without `hoisted` the factories would close over uninitialized refs.
// ---------------------------------------------------------------------------
const tableTokens = vi.hoisted(() => ({
  teams: { __table: 'teams' },
  teamMembers: { __table: 'team_members' },
  planItems: { __table: 'plan_items' },
  channels: { __table: 'channels' },
  strategicPaths: { __table: 'strategic_paths' },
  products: { __table: 'products' },
  users: { __table: 'users' },
}));

vi.mock('@/lib/db/schema', () => ({
  teams: tableTokens.teams,
  teamMembers: tableTokens.teamMembers,
  planItems: tableTokens.planItems,
  channels: tableTokens.channels,
  strategicPaths: tableTokens.strategicPaths,
}));
vi.mock('@/lib/db/schema/products', () => ({
  products: tableTokens.products,
}));
vi.mock('@/lib/db/schema/users', () => ({
  users: tableTokens.users,
}));

// drizzle-orm exposes `eq`, `and`, `desc`, `sql`, etc. The implementation
// uses these only as filter predicates which the fake db treats as opaque
// — so we just return the raw args so the call sites compile.
vi.mock('drizzle-orm', async (importOriginal) => {
  const orig = await importOriginal<typeof import('drizzle-orm')>();
  return {
    ...orig,
    // Override the predicates the implementation builds — the fake db
    // ignores them, so identity stand-ins are sufficient.
    eq: (...a: unknown[]) => ({ __op: 'eq', args: a }),
    and: (...a: unknown[]) => ({ __op: 'and', args: a }),
    desc: (...a: unknown[]) => ({ __op: 'desc', args: a }),
    gte: (...a: unknown[]) => ({ __op: 'gte', args: a }),
    lt: (...a: unknown[]) => ({ __op: 'lt', args: a }),
    sql: Object.assign(
      (...a: unknown[]) => ({ __op: 'sql', args: a }),
      { raw: (...a: unknown[]) => ({ __op: 'sql.raw', args: a }) },
    ),
  };
});

// ---------------------------------------------------------------------------
// Fake db builder. Per-test, callers supply a `tableResults` map keyed by
// the same table tokens above. `select(...).from(<token>)...` resolves to
// the matching array. This sidesteps the deep Drizzle builder signature
// while keeping the test focused on input shape vs output shape.
// ---------------------------------------------------------------------------
type FakeRow = Record<string, unknown>;

interface FakeDbOpts {
  tableResults?: Map<unknown, FakeRow[]>;
}

function makeDb(opts: FakeDbOpts = {}) {
  const tableResults = opts.tableResults ?? new Map<unknown, FakeRow[]>();
  return {
    select: vi.fn((_projection?: unknown) => {
      let activeRows: FakeRow[] = [];
      const builder = {
        from: (token: unknown) => {
          activeRows = tableResults.get(token) ?? [];
          return builder;
        },
        where: () => builder,
        orderBy: () => builder,
        leftJoin: () => builder,
        innerJoin: () => builder,
        groupBy: () => builder,
        // Awaiting `limit(n)` resolves the chain to the first n rows.
        limit: (n: number) => Promise.resolve(activeRows.slice(0, n)),
        // Awaiting the builder itself (no `.limit`) resolves to all rows.
        then: (resolve: (rows: FakeRow[]) => void) => resolve(activeRows),
      };
      return builder;
    }),
  };
}

beforeEach(() => {
  resolveAgentMock.mockReset();
});

// ===========================================================================
// substitutePlaceholders — synchronous, no DB
// ===========================================================================

describe('substitutePlaceholders', () => {
  it('replaces every documented token', () => {
    const tpl =
      'P:{productName} D:{productDescription} S:{productState} F:{currentPhase} ' +
      'C:{channels} A:{pathId | "none yet"} I:{itemCount} B:{statusBreakdown} ' +
      'T:{TEAM_ROSTER} N:{founderName}';
    const out = substitutePlaceholders(tpl, {
      productName: 'Acme',
      productDescription: 'a thing',
      productState: 'launched',
      currentPhase: 'growth',
      channels: 'x, reddit',
      strategicPathId: 'sp_123',
      itemCount: 5,
      statusBreakdown: 'planned: 3, drafted: 2',
      founderName: 'Alex',
      teamRoster: '- coordinator: Chief of Staff',
    });
    expect(out).toBe(
      'P:Acme D:a thing S:launched F:growth C:x, reddit A:sp_123 I:5 B:planned: 3, drafted: 2 T:- coordinator: Chief of Staff N:Alex',
    );
  });

  it('leaves unknown braces untouched (never throws on missing tokens)', () => {
    const ctx: SystemPromptContext = {
      productName: 'p',
      productDescription: 'd',
      productState: 's',
      currentPhase: 'c',
      channels: 'ch',
      strategicPathId: 'sp',
      itemCount: 0,
      statusBreakdown: '',
      founderName: 'f',
      teamRoster: 'r',
    };
    expect(substitutePlaceholders('hello {unknown}', ctx)).toBe(
      'hello {unknown}',
    );
  });

  it('matches {pathId | "none yet"} BEFORE {pathId} so the literal tail is not orphaned', () => {
    const ctx: SystemPromptContext = {
      productName: 'p',
      productDescription: 'd',
      productState: 's',
      currentPhase: 'c',
      channels: 'ch',
      strategicPathId: 'sp_active',
      itemCount: 0,
      statusBreakdown: '',
      founderName: 'f',
      teamRoster: 'r',
    };
    // Two forms in the same template; both should map to strategicPathId
    // and neither leaves a `| "none yet"` tail behind.
    const out = substitutePlaceholders(
      'long={pathId | "none yet"} short={pathId}',
      ctx,
    );
    expect(out).toBe('long=sp_active short=sp_active');
    expect(out).not.toContain('| "none yet"');
  });
});

// ===========================================================================
// loadSystemPromptContext
// ===========================================================================

describe('loadSystemPromptContext', () => {
  it('returns sane defaults when no product / path / items / channels exist', async () => {
    const tableResults = new Map<unknown, FakeRow[]>();
    // team exists but no productId, no path, no items, no channels.
    tableResults.set(tableTokens.teams, [
      { id: 'team-1', userId: 'user-1', productId: null },
    ]);
    tableResults.set(tableTokens.teamMembers, []);
    tableResults.set(tableTokens.planItems, []);
    tableResults.set(tableTokens.channels, []);
    tableResults.set(tableTokens.strategicPaths, []);
    tableResults.set(tableTokens.products, []);
    tableResults.set(tableTokens.users, [
      { id: 'user-1', name: null, email: null },
    ]);

    const db = makeDb({ tableResults });
    const ctx = await loadSystemPromptContext({
      teamId: 'team-1',
      db: db as never,
    });

    expect(ctx.productName).toBe('your product');
    expect(ctx.productDescription).toBe('(product not configured)');
    expect(ctx.productState).toBe('unknown');
    expect(ctx.currentPhase).toBe('unknown');
    expect(ctx.strategicPathId).toBe('none yet');
    expect(ctx.channels).toBe('none yet');
    expect(ctx.itemCount).toBe(0);
    expect(ctx.statusBreakdown).toBe('');
    expect(ctx.founderName).toBe('founder');
    // No team_members rows → empty roster, but never throws.
    expect(typeof ctx.teamRoster).toBe('string');
  });

  it('composes the happy path correctly', async () => {
    const tableResults = new Map<unknown, FakeRow[]>();
    tableResults.set(tableTokens.teams, [
      { id: 'team-77', userId: 'user-77', productId: 'prod-77' },
    ]);
    tableResults.set(tableTokens.products, [
      {
        id: 'prod-77',
        userId: 'user-77',
        name: 'Acme',
        description: 'a magical thing',
        state: 'launched',
      },
    ]);
    tableResults.set(tableTokens.strategicPaths, [
      { id: 'sp-active', userId: 'user-77', phase: 'growth' },
    ]);
    tableResults.set(tableTokens.channels, [
      { platform: 'x' },
      { platform: 'reddit' },
    ]);
    // Status rows: planned has the highest count, then drafted, then
    // scheduled. The implementation must sort by count desc.
    tableResults.set(tableTokens.planItems, [
      { state: 'planned', count: 5 },
      { state: 'drafted', count: 2 },
      { state: 'scheduled', count: 1 },
    ]);
    tableResults.set(tableTokens.users, [
      { id: 'user-77', name: 'Alex', email: 'alex@example.com' },
    ]);
    tableResults.set(tableTokens.teamMembers, [
      { id: 'tm-1', teamId: 'team-77', agentType: 'coordinator' },
      { id: 'tm-2', teamId: 'team-77', agentType: 'content-manager' },
    ]);
    resolveAgentMock.mockImplementation(async (name: string) => {
      if (name === 'coordinator') {
        return {
          name: 'coordinator',
          description: 'Chief of Staff',
          tools: ['Task', 'SendMessage'],
        };
      }
      if (name === 'content-manager') {
        return {
          name: 'content-manager',
          description: 'Drafts posts',
          tools: ['draft_post'],
        };
      }
      return null;
    });

    const db = makeDb({ tableResults });
    const ctx = await loadSystemPromptContext({
      teamId: 'team-77',
      db: db as never,
    });

    expect(ctx.productName).toBe('Acme');
    expect(ctx.productDescription).toBe('a magical thing');
    expect(ctx.productState).toBe('launched');
    expect(ctx.currentPhase).toBe('growth');
    expect(ctx.strategicPathId).toBe('sp-active');
    expect(ctx.channels).toBe('x, reddit');
    expect(ctx.itemCount).toBe(8);
    // Sorted by count descending; '0' rows omitted by definition (none in
    // the input fixture).
    expect(ctx.statusBreakdown).toBe('planned: 5, drafted: 2, scheduled: 1');
    expect(ctx.founderName).toBe('Alex');
    // Roster contains one line per resolved agent.
    expect(ctx.teamRoster).toContain('coordinator');
    expect(ctx.teamRoster).toContain('content-manager');
    // formatAgentLine signature: '- name: description (Tools: ...)'
    expect(ctx.teamRoster).toMatch(/^- coordinator:/m);
  });

  it('throws when team is not found', async () => {
    const tableResults = new Map<unknown, FakeRow[]>();
    tableResults.set(tableTokens.teams, []);
    const db = makeDb({ tableResults });
    await expect(
      loadSystemPromptContext({ teamId: 'missing-team', db: db as never }),
    ).rejects.toThrow(/team not found/i);
  });
});
