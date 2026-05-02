// Phase J — content-manager StructuredOutput schema (renamed from
// community-manager). After running a reply sweep OR a post batch, the
// agent terminates with { status, counts, notes } so the caller (daily
// cron, plan-execute, coordinator) can attribute draft volume across
// both flows.
//
// `threadsScanned` is preserved for reply_sweep callers (they expect
// "number of threads inspected"); post_batch callers report 0 there
// and rely on `draftsCreated` / `draftsSkipped`.

import { z } from 'zod';

export const contentManagerOutputSchema = z.object({
  status: z.enum(['completed', 'partial', 'failed']),
  threadsScanned: z.number().int().min(0),
  draftsCreated: z.number().int().min(0),
  draftsSkipped: z.number().int().min(0),
  skippedRationale: z.string(),
  notes: z.string(),
});

export type ContentManagerOutput = z.infer<typeof contentManagerOutputSchema>;

// Backwards-compat alias for code that hasn't migrated yet (e.g. older
// imports of `communityManagerOutputSchema` from
// `@/tools/AgentTool/agents/community-manager/schema`). Prefer the
// `contentManager*` names in new code.
export const communityManagerOutputSchema = contentManagerOutputSchema;
export type CommunityManagerOutput = ContentManagerOutput;
