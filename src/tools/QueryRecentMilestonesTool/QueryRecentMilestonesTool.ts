// query_recent_milestones — recent shipping signals (commits, PRs, releases)
// for the current product.
//
// There's no dedicated milestones table in v3 yet. The closest existing
// source is `code_snapshots`: when a fresh GitHub scan detects a diff, it
// writes `diffSummary` + `changesDetected=true` with `lastDiffAt`. That
// row IS the latest shipping signal for the product — aggregating it
// across the `sinceDays` window is the intent of this tool.
//
// This is intentionally low-fidelity vs CC's AI-enriched milestones:
// extracting a title / category would require another LLM call, which
// belongs in a Phase E `extract_milestone_from_commits` skill. For now
// we return the raw commit summary as the milestone title + a truncated
// diffSummary as the body, so the agent can reason over "what shipped".

import { z } from 'zod';
import { and, eq, gte, desc } from 'drizzle-orm';
import { buildTool } from '@/core/tool-system';
import type { ToolDefinition } from '@/core/types';
import { codeSnapshots } from '@/lib/db/schema';
import { readDomainDeps } from '@/tools/context-helpers';

export const QUERY_RECENT_MILESTONES_TOOL_NAME = 'query_recent_milestones';

export const queryRecentMilestonesInputSchema = z
  .object({
    sinceDays: z.number().int().min(1).max(365).optional(),
  })
  .strict();

export type QueryRecentMilestonesInput = z.infer<
  typeof queryRecentMilestonesInputSchema
>;

export interface MilestoneRow {
  title: string;
  summary: string;
  source: 'commit' | 'pr' | 'release';
  atISO: string;
}

const DEFAULT_SINCE_DAYS = 14;
const SUMMARY_TRUNCATE_CHARS = 600;

export const queryRecentMilestonesTool: ToolDefinition<
  QueryRecentMilestonesInput,
  MilestoneRow[]
> = buildTool({
  name: QUERY_RECENT_MILESTONES_TOOL_NAME,
  description:
    'List recent shipping signals (commits / PRs / releases) detected ' +
    'for the current product in the last `sinceDays` days (default 14). ' +
    'Use this to pick a thesis or anchor weekly content in what actually ' +
    'shipped.',
  inputSchema: queryRecentMilestonesInputSchema,
  isConcurrencySafe: true,
  isReadOnly: true,
  async execute(input, ctx): Promise<MilestoneRow[]> {
    const { db, userId, productId } = readDomainDeps(ctx);
    const sinceDays = input.sinceDays ?? DEFAULT_SINCE_DAYS;
    const cutoff = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);

    const rows = await db
      .select({
        commitSha: codeSnapshots.commitSha,
        diffSummary: codeSnapshots.diffSummary,
        changesDetected: codeSnapshots.changesDetected,
        lastDiffAt: codeSnapshots.lastDiffAt,
        scannedAt: codeSnapshots.scannedAt,
        scanSummary: codeSnapshots.scanSummary,
      })
      .from(codeSnapshots)
      .where(
        and(
          eq(codeSnapshots.userId, userId),
          eq(codeSnapshots.productId, productId),
          gte(codeSnapshots.scannedAt, cutoff),
        ),
      )
      .orderBy(desc(codeSnapshots.scannedAt))
      .limit(20);

    // A code_snapshots row only carries a meaningful shipping signal when
    // changesDetected is true AND we have a diffSummary. Filter out rows
    // that only carry an initial scan or a re-scan with no diff.
    return rows
      .filter((r) => r.changesDetected === true && r.diffSummary)
      .map((r) => {
        const at = r.lastDiffAt ?? r.scannedAt;
        const summary = (r.diffSummary ?? '').slice(0, SUMMARY_TRUNCATE_CHARS);
        // Title: first line of the diff summary, capped. Commit subjects
        // are the standard convention; if the scanner wrote paragraphs,
        // we still surface something readable.
        const firstLine = summary.split('\n')[0]?.trim() ?? 'Code change';
        const title = firstLine.length > 0 ? firstLine.slice(0, 120) : 'Code change';
        return {
          title,
          summary,
          source: 'commit',
          atISO: at instanceof Date ? at.toISOString() : String(at),
        };
      });
  },
});
