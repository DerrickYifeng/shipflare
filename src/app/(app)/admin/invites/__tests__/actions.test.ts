import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Capture DB calls so we can assert (a) update happened, (b) sessions
// delete happened, (c) admin guard skipped them when expected.
const insertCalls: unknown[] = [];
const updateCalls: unknown[] = [];
const deleteCalls: unknown[] = [];

// Waitlist-specific mock handles for approve/dismiss assertions.
// selectFromMock controls what db.select().from().where().limit() returns.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const selectFromMock = vi.fn<() => Promise<any[]>>().mockResolvedValue([]);
// insertIntoAllowed tracks the args passed to the tx.insert().values().onConflictDoUpdate() path.
const insertIntoAllowed: unknown[] = [];
// updateWaitlist tracks args passed to tx.update(waitlistSignups).set(...).where(...)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const updateWaitlist = vi.fn<(vals: any) => void>();

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
    // select chain: db.select({...}).from(...).where(...).limit(n)
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => selectFromMock(),
        }),
      }),
    }),
    // transaction: runs the callback with a tx object that captures
    // insert (into allowed_emails) and update (into waitlist_signups).
    transaction: async (fn: (tx: unknown) => Promise<void>) => {
      const tx = {
        insert: () => ({
          values: (vals: unknown) => ({
            onConflictDoUpdate: (args: unknown) => {
              insertIntoAllowed.push({ vals, args });
              return Promise.resolve();
            },
          }),
        }),
        update: () => ({
          set: (vals: unknown) => ({
            where: () => {
              updateWaitlist(vals);
              return Promise.resolve();
            },
          }),
        }),
      };
      await fn(tx);
    },
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
    isNull: () => ({ _isNull: true }),
    isNotNull: () => ({ _isNotNull: true }),
    desc: () => ({ _desc: true }),
    asc: () => ({ _asc: true }),
    sql: Object.assign(
      (..._args: unknown[]) => ({ _sql: true }),
      { raw: () => ({ _sql_raw: true }) },
    ),
  };
});

// sendEmail mock — declared before the actions import so the mock is in place.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sendEmailMock = vi.fn<(payload: any) => Promise<{ ok: boolean; reason?: string }>>()
  .mockResolvedValue({ ok: true });
vi.mock('@/lib/email', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sendEmail: (payload: any) => sendEmailMock(payload),
}));

const { addInvite, revokeInvite, updateNote, approveWaitlistSignup, dismissWaitlistSignup } =
  await import('../actions');

beforeEach(() => {
  insertCalls.length = 0;
  updateCalls.length = 0;
  deleteCalls.length = 0;
  insertIntoAllowed.length = 0;
  mockRequireAdmin.mockReset();
  selectFromMock.mockReset().mockResolvedValue([]);
  updateWaitlist.mockReset();
  sendEmailMock.mockReset().mockResolvedValue({ ok: true });
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

// ---------------------------------------------------------------------------
// approveWaitlistSignup
// ---------------------------------------------------------------------------

describe('approveWaitlistSignup', () => {
  it('requires admin', async () => {
    vi.mocked(mockRequireAdmin).mockRejectedValueOnce(new Error('not admin'));
    await expect(approveWaitlistSignup('00000000-0000-0000-0000-000000000001')).rejects.toThrow('not admin');
  });

  it('inserts into allowed_emails and updates the waitlist row in a transaction', async () => {
    vi.mocked(mockRequireAdmin).mockResolvedValueOnce('admin@x.com');
    selectFromMock.mockResolvedValueOnce([
      { id: '00000000-0000-0000-0000-000000000001', email: 'newuser@example.com' },
    ]);

    const result = await approveWaitlistSignup('00000000-0000-0000-0000-000000000001');

    expect(result).toEqual({ ok: true });
    // allowed_emails INSERT with un-revoke on conflict
    expect(insertIntoAllowed).toHaveLength(1);
    // waitlist_signups UPDATE
    expect(updateWaitlist).toHaveBeenCalledWith(
      expect.objectContaining({
        approvedBy: 'admin@x.com',
      }),
    );
  });

  it('sends an approval email to the applicant fire-and-forget', async () => {
    vi.mocked(mockRequireAdmin).mockResolvedValueOnce('admin@x.com');
    selectFromMock.mockResolvedValueOnce([
      { id: '00000000-0000-0000-0000-000000000001', email: 'newuser@example.com' },
    ]);

    await approveWaitlistSignup('00000000-0000-0000-0000-000000000001');

    expect(sendEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'newuser@example.com' }),
    );
  });

  it('does not fail the action when the approval email errors', async () => {
    vi.mocked(mockRequireAdmin).mockResolvedValueOnce('admin@x.com');
    selectFromMock.mockResolvedValueOnce([
      { id: '00000000-0000-0000-0000-000000000001', email: 'newuser@example.com' },
    ]);
    sendEmailMock.mockResolvedValueOnce({ ok: false, reason: 'smtp' });

    const result = await approveWaitlistSignup('00000000-0000-0000-0000-000000000001');
    expect(result).toEqual({ ok: true });
  });

  it('returns error when the waitlist row is not found', async () => {
    vi.mocked(mockRequireAdmin).mockResolvedValueOnce('admin@x.com');
    selectFromMock.mockResolvedValueOnce([]);
    const result = await approveWaitlistSignup('00000000-0000-0000-0000-000000000099');
    expect(result).toEqual({ ok: false, error: 'Waitlist row not found.' });
  });
});

// ---------------------------------------------------------------------------
// dismissWaitlistSignup
// ---------------------------------------------------------------------------

describe('dismissWaitlistSignup', () => {
  it('requires admin', async () => {
    vi.mocked(mockRequireAdmin).mockRejectedValueOnce(new Error('not admin'));
    await expect(dismissWaitlistSignup('00000000-0000-0000-0000-000000000001')).rejects.toThrow('not admin');
  });

  it('marks the row dismissed_at + dismissed_by', async () => {
    vi.mocked(mockRequireAdmin).mockResolvedValueOnce('admin@x.com');
    await dismissWaitlistSignup('00000000-0000-0000-0000-000000000001');
    expect(updateCalls).toHaveLength(1);
    const upd = updateCalls[0] as { vals: { dismissedBy: string } };
    expect(upd.vals.dismissedBy).toBe('admin@x.com');
  });

  it('does not send any email', async () => {
    vi.mocked(mockRequireAdmin).mockResolvedValueOnce('admin@x.com');
    await dismissWaitlistSignup('00000000-0000-0000-0000-000000000001');
    expect(sendEmailMock).not.toHaveBeenCalled();
  });
});
