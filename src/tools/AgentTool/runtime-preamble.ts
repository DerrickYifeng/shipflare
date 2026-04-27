// Runtime date grounding for every agent in the team.
//
// Haiku 4.5's training cutoff predates 2026. Left to its own devices it
// writes ISO timestamps from its training-data era (we saw it schedule
// a full week of plan_items into July 2025 during onboarding). Injecting
// the current date into the system prompt at spawn time fixes that: the
// agent reads the block before its own playbook, so references to
// "this week" / "weekStart" resolve to the actual current week.
//
// Lives here (next to loader/spawn) rather than in a per-agent reference
// so one injection covers every agent — root, coordinator, content-
// planner, writers — without per-agent playbook edits.

/**
 * Monday 00:00:00.000 UTC of the week containing `now`. Matches the week
 * boundary the /api/calendar route and the content-planner playbook use,
 * so weekStart stays consistent between the prompt and the view layer.
 */
export function thisMondayUtc(now: Date): Date {
  const monday = new Date(now);
  monday.setUTCHours(0, 0, 0, 0);
  const dayOffset = (monday.getUTCDay() + 6) % 7; // Monday = 0
  monday.setUTCDate(monday.getUTCDate() - dayOffset);
  return monday;
}

/**
 * Render the runtime-context preamble that gets prepended to every
 * agent's system prompt. `now` is injectable so tests can pin time.
 */
export function renderRuntimePreamble(now: Date = new Date()): string {
  const todayYmd = now.toISOString().slice(0, 10);
  const nowIso = now.toISOString();
  const weekStartIso = thisMondayUtc(now).toISOString();

  return [
    '# Runtime context',
    '',
    `- **Today (UTC YMD):** ${todayYmd}`,
    `- **Now (UTC ISO):** ${nowIso}`,
    `- **This week\'s Monday (UTC ISO, "weekStart"):** ${weekStartIso}`,
    '',
    'Use these values verbatim whenever you schedule plan_items, reason',
    'about "this week" / "next week", or emit an ISO timestamp. Your',
    'training data does not reflect the current date — trust this block',
    'instead.',
    '',
    '---',
    '',
    '',
  ].join('\n');
}
