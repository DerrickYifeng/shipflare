// query_code_changes — list commits the user has shipped in a window.
//
// On-demand clone: every call clones the repo fresh and runs
// `git log --since={sinceISO} --until={untilISO}`. No DB cache, no
// Haiku filter. The `code_snapshots` row is consulted only for
// repoFullName + token resolution; it carries no diff state after the
// daily-diff cron deletion (see plan task 7).
//
// Replaces the misnamed `query_recent_milestones`. Same userId/productId
// scoping; entirely different data path (live git instead of stale DB).

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { buildTool } from '@/core/tool-system';
import type { ToolDefinition } from '@/core/types';
import { db } from '@/lib/db';
import { codeSnapshots } from '@/lib/db/schema';
import { readDomainDeps } from '@/tools/context-helpers';
import { cloneRepo, cleanupClone } from '@/services/code-scanner';
import { getGitHubToken } from '@/lib/github';
import { createLogger } from '@/lib/logger';

const log = createLogger('tool:query-code-changes');

// `git log` output uses NUL (0x00) between fields and RS (0x1e) between
// records, set via `--format=%H%x00%aI%x00%s%x00%b%x1e`. Keep these as
// named constants so the parser stays grep-able and we never accidentally
// embed bare control bytes in source.
const FIELD_SEP = String.fromCharCode(0x00);
const RECORD_SEP = String.fromCharCode(0x1e);

interface ExecFileResult {
  stdout: string;
  stderr: string;
}

// Narrow the promisified execFile signature so we don't need an `any` cast
// in the test mock: the test replaces `node:util`'s `promisify` with an
// identity wrapper around its own mock and the type below describes the
// exact shape both the real and the mocked function expose.
type ExecFileAsync = (
  file: string,
  args: ReadonlyArray<string>,
  options: { cwd?: string; timeout?: number; maxBuffer?: number },
) => Promise<ExecFileResult>;

const execFileAsync = promisify(execFile) as unknown as ExecFileAsync;

export const QUERY_CODE_CHANGES_TOOL_NAME = 'query_code_changes';

const MAX_COMMITS = 50;
const MAX_BODY_CHARS = 600;
const GIT_TIMEOUT_MS = 30_000;
const MAX_GIT_BUFFER_BYTES = 10 * 1024 * 1024;

export const queryCodeChangesInputSchema = z
  .object({
    sinceISO: z.string().datetime(),
    untilISO: z.string().datetime().optional(),
  })
  .strict();

export type QueryCodeChangesInput = z.infer<typeof queryCodeChangesInputSchema>;

export interface CodeChangeRow {
  kind: 'commit';
  sha: string;
  title: string;
  body: string;
  atISO: string;
}

export const queryCodeChangesTool: ToolDefinition<
  QueryCodeChangesInput,
  CodeChangeRow[]
> = buildTool({
  name: QUERY_CODE_CHANGES_TOOL_NAME,
  description:
    'List git commits the user has shipped in a date window. Use to ' +
    'understand what actually changed in the product since the last ' +
    'planning cycle. On-demand clone — fresh data every call. Returns ' +
    'up to 50 commits with sha, subject, body (truncated to 600 chars), ' +
    'and ISO timestamp.',
  inputSchema: queryCodeChangesInputSchema,
  isConcurrencySafe: true,
  isReadOnly: true,
  async execute(input, ctx): Promise<CodeChangeRow[]> {
    const { userId, productId } = readDomainDeps(ctx);

    const [snap] = await db
      .select({ repoFullName: codeSnapshots.repoFullName })
      .from(codeSnapshots)
      .where(
        and(
          eq(codeSnapshots.userId, userId),
          eq(codeSnapshots.productId, productId),
        ),
      )
      .limit(1);

    if (!snap?.repoFullName) {
      throw new Error('no_repo: user has not connected a GitHub repo');
    }

    const token = await getGitHubToken(userId);
    if (!token) {
      throw new Error('no_github_token: GitHub OAuth disconnected');
    }

    const cloneDir = await cloneRepo(snap.repoFullName, token);
    try {
      const args = [
        'log',
        `--since=${input.sinceISO}`,
        ...(input.untilISO ? [`--until=${input.untilISO}`] : []),
        `--max-count=${MAX_COMMITS}`,
        '--format=%H%x00%aI%x00%s%x00%b%x1e',
      ];
      const { stdout } = await execFileAsync('git', args, {
        cwd: cloneDir,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: MAX_GIT_BUFFER_BYTES,
      });

      if (!stdout.trim()) return [];

      const records = stdout
        .split(RECORD_SEP)
        .map((r) => r.trim())
        .filter((r) => r.length > 0);

      const out: CodeChangeRow[] = [];
      for (const r of records.slice(0, MAX_COMMITS)) {
        const [sha, atISO, title, body = ''] = r.split(FIELD_SEP);
        if (!sha || !atISO || !title) continue;
        out.push({
          kind: 'commit',
          sha,
          title,
          body: body.slice(0, MAX_BODY_CHARS),
          atISO,
        });
      }
      log.info(
        `query_code_changes user=${userId} returned ${out.length} commits`,
      );
      return out;
    } finally {
      await cleanupClone(cloneDir);
    }
  },
});
