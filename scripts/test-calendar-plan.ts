/**
 * Ad-hoc: invoke the calendar-planner skill with a synthetic but realistic
 * input, print the output, and verify structural properties.
 *
 * Run:
 *   pnpm tsx scripts/test-calendar-plan.ts
 *
 * Requires ANTHROPIC_API_KEY in the shell env. Does NOT touch the DB or queue.
 */
import 'dotenv/config';
import { join } from 'node:path';
import { loadSkill } from '@/core/skill-loader';
import { runSkill } from '@/core/skill-runner';
import { calendarPlanOutputSchema, type CalendarPlanOutput } from '@/agents/schemas';

const bar = '─'.repeat(72);

const INPUT = {
  channel: 'x',
  productName: 'ShipFlare',
  productDescription: 'AI marketing autopilot that drafts X replies and posts so indie devs show up daily',
  valueProp: 'ship marketing on autopilot',
  keywords: ['indie hacker', 'buildinpublic', 'SaaS', 'marketing'],
  lifecyclePhase: 'launched',
  followerCount: 340,
  startDate: new Date().toISOString(),
  postingHours: [14, 17, 21],
  milestoneContext: 'shipped the new reply-hardening pipeline this week — drafts now pass an AI-slop + anchor-token validator and a separate product-mention judge',
  topPerformingContent: [],
};

const run = async () => {
  const skill = loadSkill(join(process.cwd(), 'src/skills/calendar-planner'));
  console.log('Running calendar-planner with milestone context...');
  console.log(bar);

  const result = await runSkill<CalendarPlanOutput>({
    skill,
    input: INPUT,
    deps: {},
    outputSchema: calendarPlanOutputSchema,
    runId: `test-calendar-${Date.now()}`,
  });

  if (result.errors.length > 0) {
    console.error('\nErrors:');
    for (const e of result.errors) console.error(`  - ${e.label ?? 'unknown'}: ${e.error}`);
  }

  const plan = result.results[0];
  if (!plan) {
    console.error('No plan produced. Aborting.');
    process.exit(1);
  }

  console.log(`\nphase: ${plan.phase}`);
  console.log(`weeklyStrategy: ${plan.weeklyStrategy}`);
  console.log(`thesis: ${plan.thesis}`);
  console.log(`thesisSource: ${plan.thesisSource}`);
  console.log(`pillar: ${plan.pillar ?? '(none)'}`);
  console.log(`fallbackMode: ${plan.fallbackMode ?? '(none)'}`);
  console.log(`whiteSpaceDayOffsets: [${plan.whiteSpaceDayOffsets.join(', ')}]`);
  console.log(`\nentries (${plan.entries.length}):`);
  for (const e of plan.entries) {
    console.log(
      `  day ${e.dayOffset} @ ${String(e.hour).padStart(2, '0')}:00  ` +
      `${e.contentType.padEnd(12)} ${e.angle.padEnd(11)}  ${e.topic}`,
    );
  }

  console.log(`\n${bar}\nStructural checks:`);
  const checks: Array<[string, boolean, string]> = [];

  // 1. Thesis is a full claim, not a topic
  checks.push([
    'thesis length ≥ 20 chars (full claim, not a single word)',
    plan.thesis.length >= 20,
    `thesis = "${plan.thesis}" (${plan.thesis.length} chars)`,
  ]);

  // 2. Day 0 has angle=claim
  const day0 = plan.entries.find((e) => e.dayOffset === 0);
  checks.push([
    'Day 0 angle = "claim"',
    day0?.angle === 'claim',
    `day 0 angle = ${day0?.angle ?? '(no entry)'}`,
  ]);

  // 3. Last active day has angle=synthesis
  const activeDays = plan.entries.map((e) => e.dayOffset);
  const lastDay = Math.max(...activeDays);
  const lastEntries = plan.entries.filter((e) => e.dayOffset === lastDay);
  checks.push([
    'last active day has a "synthesis" slot',
    lastEntries.some((e) => e.angle === 'synthesis'),
    `day ${lastDay} angles = ${lastEntries.map((e) => e.angle).join(', ')}`,
  ]);

  // 4. No angle repeated more than N times (allow repeats only across multi-hour slots; primary rule: each DAY has distinct angles)
  const anglesByDay = new Map<number, string[]>();
  for (const e of plan.entries) {
    if (!anglesByDay.has(e.dayOffset)) anglesByDay.set(e.dayOffset, []);
    anglesByDay.get(e.dayOffset)!.push(e.angle);
  }
  const distinctWithinDay = Array.from(anglesByDay.values()).every(
    (angles) => new Set(angles).size === angles.length,
  );
  checks.push([
    'no angle repeated within the same day',
    distinctWithinDay,
    `anglesByDay = ${JSON.stringify(Object.fromEntries(anglesByDay))}`,
  ]);

  // 5. whiteSpaceDayOffsets has length 1 or 2
  checks.push([
    'whiteSpaceDayOffsets length is 1 or 2',
    plan.whiteSpaceDayOffsets.length >= 1 && plan.whiteSpaceDayOffsets.length <= 2,
    `length = ${plan.whiteSpaceDayOffsets.length}`,
  ]);

  // 6. topic length ≤ 120 for all entries (headline rule)
  const tooLong = plan.entries.filter((e) => e.topic.length > 120);
  checks.push([
    'all topics ≤ 120 chars',
    tooLong.length === 0,
    tooLong.length > 0 ? `${tooLong.length} over limit: ${tooLong.map((e) => e.topic.length).join(', ')}` : 'ok',
  ]);

  // 7. thesisSource matches milestone path (we provided milestoneContext)
  checks.push([
    'thesisSource = "milestone" (milestoneContext was provided)',
    plan.thesisSource === 'milestone',
    `thesisSource = ${plan.thesisSource}`,
  ]);

  let passCount = 0;
  for (const [name, ok, detail] of checks) {
    console.log(`  ${ok ? '✓' : '✗'}  ${name}`);
    if (!ok) console.log(`      ${detail}`);
    if (ok) passCount++;
  }

  console.log(`\n${passCount}/${checks.length} structural checks passed.`);
  console.log(`Cost: $${result.usage.costUsd.toFixed(4)}  tokens: ${result.usage.inputTokens} in / ${result.usage.outputTokens} out\n`);

  process.exit(passCount === checks.length ? 0 : 1);
};

run().catch((err) => {
  console.error('FATAL:', err);
  process.exit(2);
});
