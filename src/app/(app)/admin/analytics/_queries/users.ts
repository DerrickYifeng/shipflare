import { gte, or, desc } from 'drizzle-orm';
import { db } from '@/lib/db';
import { users } from '@/lib/db/schema';
import { getPartnerActivityCounts } from '@/lib/admin/partner-activity';

export interface UserRow {
  userId: string;
  email: string;
  createdAt: Date;
  lastLoginAt: Date | null;
  scans7d: number;
  replies7d: number;
  posts7d: number;
  status: 'active' | 'dormant' | 'lost' | 'stalled';
}

export async function getActiveUsers(
  opts: { now?: Date; windowDays?: number } = {},
): Promise<UserRow[]> {
  const now = opts.now ?? new Date();
  const windowDays = opts.windowDays ?? 30;
  const since = new Date(now.getTime() - windowDays * 86400_000);
  const day7 = new Date(now.getTime() - 7 * 86400_000);
  const day14 = new Date(now.getTime() - 14 * 86400_000);

  // Users who signed up or logged in within the window
  const rows = await db
    .select({
      userId: users.id,
      email: users.email,
      createdAt: users.createdAt,
      lastLoginAt: users.lastLoginAt,
    })
    .from(users)
    .where(or(gte(users.createdAt, since), gte(users.lastLoginAt, since)))
    .orderBy(desc(users.lastLoginAt));

  const counts = await getPartnerActivityCounts(rows.map((r) => r.userId));

  return rows.map((r) => {
    const c = counts.get(r.userId) ?? { posts7d: 0, replies7d: 0, scans7d: 0 };
    const hasAction = c.scans7d > 0 || c.replies7d > 0 || c.posts7d > 0;
    const signedInRecently =
      r.lastLoginAt != null && r.lastLoginAt.getTime() >= day7.getTime();
    const signedInWithin14d =
      r.lastLoginAt != null && r.lastLoginAt.getTime() >= day14.getTime();

    let status: 'active' | 'dormant' | 'lost' | 'stalled';
    if (hasAction) {
      status = 'active';
    } else if (r.lastLoginAt === null) {
      // Never logged in — signed up but didn't return
      status = 'stalled';
    } else if (signedInRecently) {
      status = 'dormant';
    } else if (!signedInWithin14d) {
      status = 'lost';
    } else {
      status = 'dormant';
    }

    return {
      userId: r.userId,
      email: r.email ?? '(no email)',
      createdAt: r.createdAt,
      lastLoginAt: r.lastLoginAt,
      scans7d: c.scans7d,
      replies7d: c.replies7d,
      posts7d: c.posts7d,
      status,
    };
  });
}
