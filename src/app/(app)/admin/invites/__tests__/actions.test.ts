import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Capture DB calls so we can assert (a) update happened, (b) sessions
// delete happened, (c) admin guard skipped them when expected.
const insertCalls: unknown[] = [];
const updateCalls: unknown[] = [];
const deleteCalls: unknown[] = [];

vi.mock('@/lib/db', () => ({
  db: {
    insert: () => ({
      values: () => ({
        onConflictDoUpdate: (args: unknown) => {
          insertCalls.push({ kind: 'upsert', args });
          return Promise.resolve();
        },
      }),
    }),
    update: () => ({
      set: (vals: unknown) => ({
        where: (clause: unknown) => {
          updateCalls.push({ vals, clause });
          return Promise.resolve();
        },
      }),
    }),
    delete: () => ({
      where: (clause: unknown) => {
        deleteCalls.push({ clause });
        return Promise.resolve();
      },
    }),
  },
}));

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

const mockRequireAdmin = vi.fn();
vi.mock('@/lib/admin', () => ({
  requireAdmin: () => mockRequireAdmin(),
}));

vi.mock('drizzle-orm', async () => {
  const actual = await vi.importActual<typeof import('drizzle-orm')>(
    'drizzle-orm',
  );
  return {
    ...actual,
    eq: () => ({ _eq: true }),
    and: () => ({ _and: true }),
    sql: Object.assign(
      (..._args: unknown[]) => ({ _sql: true }),
      { raw: () => ({ _sql_raw: true }) },
    ),
  };
});

const { addInvite, revokeInvite, updateNote } = await import('../actions');

beforeEach(() => {
  insertCalls.length = 0;
  updateCalls.length = 0;
  deleteCalls.length = 0;
  mockRequireAdmin.mockReset();
});

afterEach(() => {
  delete process.env.SUPER_ADMIN_EMAIL;
});

function fd(entries: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
}

// ---------------------------------------------------------------------------
// Admin guard: every action MUST require admin
// ---------------------------------------------------------------------------

describe('admin guard', () => {
  it('addInvite propagates requireAdmin rejection', async () => {
    mockRequireAdmin.mockRejectedValueOnce(new Error('not_found'));
    await expect(addInvite(fd({ email: 'p@x.com' }))).rejects.toThrow(
      'not_found',
    );
    expect(insertCalls).toHaveLength(0);
  });

  it('revokeInvite propagates requireAdmin rejection', async () => {
    mockRequireAdmin.mockRejectedValueOnce(new Error('not_found'));
    await expect(revokeInvite(fd({ email: 'p@x.com' }))).rejects.toThrow(
      'not_found',
    );
    expect(updateCalls).toHaveLength(0);
    expect(deleteCalls).toHaveLength(0);
  });

  it('updateNote propagates requireAdmin rejection', async () => {
    mockRequireAdmin.mockRejectedValueOnce(new Error('not_found'));
    await expect(
      updateNote(fd({ email: 'p@x.com', note: 'x' })),
    ).rejects.toThrow('not_found');
    expect(updateCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// addInvite happy/edge paths
// ---------------------------------------------------------------------------

describe('addInvite', () => {
  it('rejects malformed email', async () => {
    mockRequireAdmin.mockResolvedValueOnce('admin@x.com');
    const result = await addInvite(fd({ email: 'not-an-email' }));
    expect(result.ok).toBe(false);
    expect(insertCalls).toHaveLength(0);
  });

  it('upserts a normalized email and revives revoked rows', async () => {
    mockRequireAdmin.mockResolvedValueOnce('admin@x.com');
    const result = await addInvite(
      fd({ email: '  Partner@Example.COM ', note: 'YC dinner' }),
    );
    expect(result).toEqual({ ok: true });
    expect(insertCalls).toHaveLength(1);
    // Confirm un-revoke is part of the conflict path.
    const upsert = insertCalls[0] as { args: { set: { revokedAt: null } } };
    expect(upsert.args.set.revokedAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// revokeInvite — including SUPER_ADMIN_EMAIL guard
// ---------------------------------------------------------------------------

describe('revokeInvite', () => {
  it('refuses to revoke SUPER_ADMIN_EMAIL', async () => {
    process.env.SUPER_ADMIN_EMAIL = 'founder@x.com';
    mockRequireAdmin.mockResolvedValueOnce('founder@x.com');
    const result = await revokeInvite(fd({ email: 'Founder@X.com' }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/SUPER_ADMIN_EMAIL/);
    }
    expect(updateCalls).toHaveLength(0);
    expect(deleteCalls).toHaveLength(0);
  });

  it('soft-deletes invite AND deletes active sessions for partner', async () => {
    mockRequireAdmin.mockResolvedValueOnce('founder@x.com');
    const result = await revokeInvite(fd({ email: 'partner@x.com' }));
    expect(result).toEqual({ ok: true });
    expect(updateCalls).toHaveLength(1);
    expect(deleteCalls).toHaveLength(1);
    // Confirm we set revokedAt to a Date value.
    const upd = updateCalls[0] as { vals: { revokedAt: Date } };
    expect(upd.vals.revokedAt).toBeInstanceOf(Date);
  });
});

// ---------------------------------------------------------------------------
// updateNote
// ---------------------------------------------------------------------------

describe('updateNote', () => {
  it('rejects oversized note', async () => {
    mockRequireAdmin.mockResolvedValueOnce('admin@x.com');
    const huge = 'x'.repeat(501);
    const result = await updateNote(fd({ email: 'p@x.com', note: huge }));
    expect(result.ok).toBe(false);
    expect(updateCalls).toHaveLength(0);
  });

  it('clears the note when given empty string', async () => {
    mockRequireAdmin.mockResolvedValueOnce('admin@x.com');
    const result = await updateNote(fd({ email: 'p@x.com', note: '' }));
    expect(result).toEqual({ ok: true });
    expect(updateCalls).toHaveLength(1);
    const upd = updateCalls[0] as { vals: { note: string | null } };
    expect(upd.vals.note).toBeNull();
  });

  it('saves a non-empty note', async () => {
    mockRequireAdmin.mockResolvedValueOnce('admin@x.com');
    const result = await updateNote(fd({ email: 'p@x.com', note: 'hello' }));
    expect(result).toEqual({ ok: true });
    expect(updateCalls).toHaveLength(1);
    const upd = updateCalls[0] as { vals: { note: string | null } };
    expect(upd.vals.note).toBe('hello');
  });
});
