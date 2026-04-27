/**
 * Seed a complete dogfood-ready user.
 *
 * Creates (or upserts) one user with an active strategic path + a current-
 * week plan + N days of plan_items, so `/today` + surrounding surfaces
 * render real data without waiting on the full onboarding flow.
 *
 * Usage:
 *
 *   DATABASE_URL=postgresql://... bun run scripts/seed-user.ts --email test@shipflare.dev
 *
 *   Flags:
 *     --email          required
 *     --state          mvp | launching | launched   (default: launching)
 *     --channels       csv e.g. "x,reddit"          (default: x,reddit)
 *     --product-name   string                        (default: "Seeded Product")
 *     --days           number of days of items      (default: 7)
 *
 * Idempotent: each run upserts the user / product / path / plan for the
 * ISO week and replaces the week's plan_items. Safe to re-run while
 * iterating on the frontend.
 *
 * At the end, prints an Auth.js session-token-based sign-in command so the
 * operator can paste the cookie directly (the app is GitHub-OAuth only and
 * the seeded user has no OAuth account).
 */
import { randomUUID, randomBytes } from 'node:crypto';
import { and, eq, gte, lt } from 'drizzle-orm';
import { db } from '../src/lib/db';
import {
  users,
  products,
  channels,
  strategicPaths,
  plans,
  planItems,
  sessions,
  userPreferences,
} from '../src/lib/db/schema';

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

interface Args {
  email: string;
  state: 'mvp' | 'launching' | 'launched';
  channels: string[];
  productName: string;
  days: number;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const opts: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      opts[key] = 'true';
    } else {
      opts[key] = next;
      i++;
    }
  }

  if (!opts.email) {
    console.error(
      'seed-user: --email is required. Example:\n' +
        '  bun run scripts/seed-user.ts --email test@shipflare.dev --state launching',
    );
    process.exit(1);
  }

  const stateRaw = opts.state ?? 'launching';
  if (!['mvp', 'launching', 'launched'].includes(stateRaw)) {
    console.error(`seed-user: --state must be mvp | launching | launched, got '${stateRaw}'`);
    process.exit(1);
  }

  const channelsRaw = opts.channels ?? 'x,reddit';
  const channelList = channelsRaw
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);
  for (const c of channelList) {
    if (!['x', 'reddit', 'email'].includes(c)) {
      console.error(`seed-user: --channels entry '${c}' must be one of x | reddit | email`);
      process.exit(1);
    }
  }

  const daysRaw = opts.days ?? '7';
  const days = Number.parseInt(daysRaw, 10);
  if (!Number.isFinite(days) || days < 1 || days > 30) {
    console.error(`seed-user: --days must be an integer in [1, 30], got '${daysRaw}'`);
    process.exit(1);
  }

  return {
    email: opts.email,
    state: stateRaw as Args['state'],
    channels: channelList,
    productName: opts['product-name'] ?? 'Seeded Product',
    days,
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function weekStartMonday(now: Date): Date {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  const dayOffset = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dayOffset);
  return d;
}

function launchDateFor(state: Args['state']): Date | null {
  if (state === 'launching') {
    // 30 days from now — middle of the [today+7d, today+90d] window.
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() + 30);
    return d;
  }
  return null;
}

function launchedAtFor(state: Args['state']): Date | null {
  if (state === 'launched') {
    // 10 days ago — within the [today-3y, today] window.
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() - 10);
    return d;
  }
  return null;
}

function derivePhaseLocal(
  state: Args['state'],
  launchDate: Date | null,
  launchedAt: Date | null,
  now: Date = new Date(),
):
  | 'foundation'
  | 'audience'
  | 'momentum'
  | 'launch'
  | 'compound'
  | 'steady' {
  const MS_PER_DAY = 86_400_000;
  if (state === 'launched') {
    if (!launchedAt) return 'steady';
    const daysSince = (now.getTime() - launchedAt.getTime()) / MS_PER_DAY;
    return daysSince <= 30 ? 'compound' : 'steady';
  }
  if (!launchDate) return 'foundation';
  const daysToLaunch = (launchDate.getTime() - now.getTime()) / MS_PER_DAY;
  if (daysToLaunch <= 0) return 'launch';
  if (daysToLaunch <= 7) return 'momentum';
  if (daysToLaunch <= 28) return 'audience';
  return 'foundation';
}

const FIXTURE_NARRATIVE =
  `This week we lean into one thesis: marketing is an approval queue, not a ` +
  `second job. Four X posts, one Reddit thread, and a single email to the ` +
  `waitlist. The biggest risk is overposting — we hedge by picking a clear ` +
  `pillar for each slot instead of chasing trends. Post-launch coverage is ` +
  `reserved for concrete wins (metrics, interviews, case studies) so the ` +
  `audience trusts the signal when it shows up.`;

const FIXTURE_PILLARS = [
  'build-in-public',
  'solo-dev-ops',
  'tooling-counterfactuals',
];

function fixturePath(args: Args, currentPhase: string) {
  return {
    narrative: FIXTURE_NARRATIVE,
    milestones: [
      {
        atDayOffset: -28,
        title: 'Hit 200 waitlist signups',
        successMetric: 'waitlist count >= 200',
        phase: 'foundation',
      },
      {
        atDayOffset: -14,
        title: 'Ship reply-guy engine',
        successMetric: '15-min reply window on 10 target accounts',
        phase: 'audience',
      },
      {
        atDayOffset: -7,
        title: 'Confirm 5 hunters',
        successMetric: 'five hunters committed in writing',
        phase: 'momentum',
      },
    ],
    thesisArc: [
      {
        weekStart: weekStartMonday(new Date()).toISOString(),
        theme: 'Marketing is an approval queue, not a second job.',
        angleMix: ['claim', 'story', 'contrarian'],
      },
    ],
    contentPillars: FIXTURE_PILLARS,
    channelMix: {
      x: { perWeek: 4, preferredHours: [14, 17, 21] },
      reddit: {
        perWeek: 1,
        preferredHours: [15],
        preferredCommunities: ['r/SideProject', 'r/indiehackers'],
      },
      email: { perWeek: 1, preferredHours: [13] },
    },
    phaseGoals: {
      foundation: 'Nail positioning + 200 waitlist signups',
      audience: 'Hit 500 followers + 50 beta users',
      momentum: '10 hunter commits + runsheet locked',
      launch: 'Top 5 of the day + 300 first-hour signups',
      compound: 'Convert launch audience into W2 retention',
    },
    phase: currentPhase,
  };
}

// ---------------------------------------------------------------------------
// Plan-items generator
// ---------------------------------------------------------------------------

interface SeedItem {
  kind:
    | 'content_post'
    | 'content_reply'
    | 'email_send'
    | 'interview'
    | 'setup_task';
  userAction: 'auto' | 'approve' | 'manual';
  channel: string | null;
  scheduledAt: Date;
  skillName: string | null;
  params: Record<string, unknown>;
  title: string;
  description: string;
}

function generatePlanItems(args: Args, weekStart: Date, phase: string): SeedItem[] {
  const items: SeedItem[] = [];
  const anchor = 'Marketing is an approval queue, not a second job.';

  const wantX = args.channels.includes('x');
  const wantReddit = args.channels.includes('reddit');
  const wantEmail = args.channels.includes('email');

  // Content posts spread across Mon-Thu 14:00 UTC, alternating channels.
  const postDays = Math.min(4, args.days);
  for (let i = 0; i < postDays; i++) {
    const day = new Date(weekStart);
    day.setUTCDate(weekStart.getUTCDate() + i);
    day.setUTCHours(14, 0, 0, 0);

    const preferReddit = wantReddit && i === 1; // Tue = reddit
    const channel = preferReddit ? 'reddit' : wantX ? 'x' : args.channels[0];
    const pillar = FIXTURE_PILLARS[i % FIXTURE_PILLARS.length];

    items.push({
      kind: 'content_post',
      userAction: 'approve',
      channel,
      scheduledAt: day,
      skillName: channel === 'x' ? 'draft-single-post' : null,
      params: { anchor_theme: anchor, pillar, angle: i === 0 ? 'claim' : 'story' },
      title: `Draft ${channel} post about ${pillar}`,
      description:
        `Anchored to this week's thesis. Angle rotates through the week so the ` +
        `cadence reads planned, not shotgun.`,
    });
  }

  if (wantEmail && args.days >= 1) {
    const monday = new Date(weekStart);
    monday.setUTCHours(13, 0, 0, 0);
    items.push({
      kind: 'email_send',
      userAction: 'approve',
      channel: 'email',
      scheduledAt: monday,
      skillName: 'draft-email',
      params: { emailType: 'welcome' },
      title: 'Welcome email for new waitlist signups',
      description: 'Short, specific, no CTA. Invites a reply.',
    });

    if (args.days >= 5) {
      const friday = new Date(weekStart);
      friday.setUTCDate(weekStart.getUTCDate() + 4);
      friday.setUTCHours(13, 0, 0, 0);
      items.push({
        kind: 'email_send',
        userAction: 'approve',
        channel: 'email',
        scheduledAt: friday,
        skillName: 'draft-email',
        params: { emailType: 'retro_week_1' },
        title: 'End-of-week retro email',
        description: 'One shipped milestone + one thing that surprised you.',
      });
    }
  }

  // Two interviews, userAction=manual.
  for (let i = 0; i < 2; i++) {
    const day = new Date(weekStart);
    day.setUTCDate(weekStart.getUTCDate() + (i === 0 ? 2 : 3));
    day.setUTCHours(19, 0, 0, 0);
    items.push({
      kind: 'interview',
      userAction: 'manual',
      channel: null,
      scheduledAt: day,
      skillName: null,
      params: { intent: 'discovery', targetCount: 1 },
      title: `Discovery interview #${i + 1}`,
      description: `30-min call with a target ICP customer. Record the pain point.`,
    });
  }

  // Two setup_tasks, manual.
  const setupTasks: Array<{ title: string; description: string }> = [
    {
      title: 'Draft positioning one-liner',
      description:
        'One sentence that names the outcome + the ICP. Test on 3 people outside the product.',
    },
    {
      title: 'Identify 10 Product Hunt hunters',
      description:
        '10 hunters who have launched in the category in the last 90 days. Store their handles.',
    },
  ];
  for (let i = 0; i < setupTasks.length; i++) {
    const day = new Date(weekStart);
    day.setUTCDate(weekStart.getUTCDate() + i);
    day.setUTCHours(10, 0, 0, 0);
    items.push({
      kind: 'setup_task',
      userAction: 'manual',
      channel: null,
      scheduledAt: day,
      skillName: null,
      params: {},
      title: setupTasks[i].title,
      description: setupTasks[i].description,
    });
  }

  void phase; // phase is written on each plan_items row at insert time.
  return items;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs();
  console.log(`seed-user: starting for ${args.email}`);
  console.log(
    `  state=${args.state} channels=[${args.channels.join(',')}] days=${args.days}`,
  );

  // 1. Upsert user
  const existingUser = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, args.email))
    .limit(1);

  let userId: string;
  if (existingUser[0]) {
    userId = existingUser[0].id;
    console.log(`  user: reused ${userId}`);
  } else {
    const [row] = await db
      .insert(users)
      .values({
        email: args.email,
        name: args.email.split('@')[0],
      })
      .returning({ id: users.id });
    userId = row.id;
    console.log(`  user: created ${userId}`);
  }

  // userPreferences — needed for timezone lookup in /api/today.
  await db
    .insert(userPreferences)
    .values({ userId })
    .onConflictDoNothing();

  // 2. Upsert product
  const launchDate = launchDateFor(args.state);
  const launchedAt = launchedAtFor(args.state);
  const currentPhase = derivePhaseLocal(args.state, launchDate, launchedAt);

  const existingProduct = await db
    .select({ id: products.id })
    .from(products)
    .where(eq(products.userId, userId))
    .limit(1);

  let productId: string;
  if (existingProduct[0]) {
    productId = existingProduct[0].id;
    await db
      .update(products)
      .set({
        name: args.productName,
        description: `Seeded product for dogfooding. State=${args.state}.`,
        valueProp: 'Ship marketing without thinking about marketing.',
        keywords: ['indiedev', 'buildinpublic'],
        category: 'dev_tool',
        targetAudience: 'Solo founders shipping weekly.',
        state: args.state,
        launchDate,
        launchedAt,
        onboardingCompletedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(products.id, productId));
    console.log(`  product: updated ${productId}`);
  } else {
    const [row] = await db
      .insert(products)
      .values({
        userId,
        name: args.productName,
        description: `Seeded product for dogfooding. State=${args.state}.`,
        valueProp: 'Ship marketing without thinking about marketing.',
        keywords: ['indiedev', 'buildinpublic'],
        category: 'dev_tool',
        targetAudience: 'Solo founders shipping weekly.',
        state: args.state,
        launchDate,
        launchedAt,
        onboardingCompletedAt: new Date(),
      })
      .returning({ id: products.id });
    productId = row.id;
    console.log(`  product: created ${productId}`);
  }

  // 3. Channel stubs
  for (const platform of args.channels) {
    if (platform === 'email') continue; // channels table is social-platform scoped
    await db
      .insert(channels)
      .values({
        userId,
        platform,
        username: `seeded-${platform}-${userId.slice(0, 8)}`,
        oauthTokenEncrypted: 'seeded-placeholder-token',
        refreshTokenEncrypted: 'seeded-placeholder-token',
      })
      .onConflictDoNothing();
  }
  console.log(`  channels: seeded ${args.channels.filter((c) => c !== 'email').length}`);

  // 4. Deactivate prior path, insert new active path
  await db
    .update(strategicPaths)
    .set({ isActive: false })
    .where(eq(strategicPaths.userId, userId));

  const path = fixturePath(args, currentPhase);
  const [pathRow] = await db
    .insert(strategicPaths)
    .values({
      userId,
      productId,
      isActive: true,
      phase: currentPhase,
      launchDate,
      launchedAt,
      narrative: path.narrative,
      milestones: path.milestones,
      thesisArc: path.thesisArc,
      contentPillars: path.contentPillars,
      channelMix: path.channelMix,
      phaseGoals: path.phaseGoals,
    })
    .returning({ id: strategicPaths.id });
  console.log(`  strategic_path: ${pathRow.id}`);

  // 5. Plans row + clear this week's items for idempotence
  const weekStart = weekStartMonday(new Date());
  const weekEnd = new Date(weekStart);
  weekEnd.setUTCDate(weekStart.getUTCDate() + 7);

  await db
    .delete(planItems)
    .where(
      and(
        eq(planItems.userId, userId),
        gte(planItems.scheduledAt, weekStart),
        lt(planItems.scheduledAt, weekEnd),
      ),
    );

  const [planRow] = await db
    .insert(plans)
    .values({
      userId,
      productId,
      strategicPathId: pathRow.id,
      trigger: 'manual',
      weekStart,
      notes: 'Seed plan generated by scripts/seed-user.ts.',
    })
    .returning({ id: plans.id });
  const planId = planRow.id;
  console.log(`  plan: ${planId}  weekStart=${weekStart.toISOString().slice(0, 10)}`);

  // 6. Plan items
  const items = generatePlanItems(args, weekStart, currentPhase);
  if (items.length > 0) {
    await db.insert(planItems).values(
      items.map((item) => ({
        userId,
        productId,
        planId,
        kind: item.kind,
        userAction: item.userAction,
        phase: currentPhase as 'foundation' | 'audience' | 'momentum' | 'launch' | 'compound' | 'steady',
        channel: item.channel,
        scheduledAt: item.scheduledAt,
        skillName: item.skillName,
        params: item.params,
        title: item.title,
        description: item.description,
      })),
    );
  }
  console.log(`  plan_items: inserted ${items.length}`);

  // 7. Mint a sessions row so the operator can sign in without GitHub OAuth.
  //    Auth.js `strategy: 'database'` means the runtime validates the
  //    cookie 'authjs.session-token' against this row.
  const sessionToken = randomBytes(32).toString('hex');
  const expires = new Date();
  expires.setUTCDate(expires.getUTCDate() + 30);

  await db.insert(sessions).values({
    sessionToken,
    userId,
    expires,
  });

  console.log('\n=== ✅ Seed complete ===');
  console.log(`user:          ${userId}`);
  console.log(`email:         ${args.email}`);
  console.log(`product:       ${productId} (${args.state}, phase=${currentPhase})`);
  console.log(`strategic_path: ${pathRow.id}`);
  console.log(`plan:          ${planId}`);
  console.log(`plan_items:    ${items.length} row(s) scheduled Mon→Sun UTC`);
  console.log('\n=== How to sign in ===');
  console.log(
    'The app is GitHub-OAuth-only. The seed minted a valid Auth.js session\n' +
      'row directly; set this cookie on http://localhost:3000 to sign in as\n' +
      'the seeded user:',
  );
  console.log('\n  Cookie name:   authjs.session-token');
  console.log(`  Cookie value:  ${sessionToken}`);
  console.log(`  Expires:       ${expires.toISOString()}`);
  console.log('\nOr via the CLI (macOS / Chromium-family):');
  console.log(
    `  • Open DevTools → Application → Cookies → http://localhost:3000`,
  );
  console.log(
    `  • Add: name=authjs.session-token, value=${sessionToken}, path=/`,
  );
  console.log('\n=== Equivalent raw SQL (already run) ===');
  console.log(
    `  INSERT INTO sessions ("sessionToken", "userId", "expires") VALUES ('${sessionToken}', '${userId}', '${expires.toISOString()}');`,
  );
  console.log('');
}

main()
  .catch((err) => {
    console.error('seed-user failed:', err);
    process.exit(1);
  })
  .finally(() => process.exit(0));
