// validate_draft — verify a draft against platform + ShipFlare-style rules.
//
// Called by: content-manager (reply_sweep + post_batch), draft-review.
// Pure, read-only, no DB writes — agents call it BEFORE persisting (e.g.
// before draft_reply or as part of draft-review).
//
// What it checks:
//
//   ERRORS  (platform will reject, or shipping damages cross-platform rep)
//     • length          — twitter-text weighted on X (URL=23, emoji=2, CJK=2);
//                         codepoints elsewhere
//     • platform_leak   — siblng-platform mention without contrast marker
//     • hallucinated_stats — unsourced number
//
//   WARNINGS (ShipFlare style — agent decides repair-or-ship)
//     • hashtag_count   — X post: 0-3, X reply: 0
//     • links_in_reply  — no URLs in X reply body
//     • links_in_post_body — X post body should route URLs to first-reply
//     • anchor_token    — X reply must contain a concrete anchor
//
// Errors set `ok = false`. Warnings do not affect `ok`.
//
// The tool also returns `repairPrompt`, a ready-to-feed-back-to-LLM
// instruction string keyed off every failure + warning, so the calling
// agent can drop it straight into a regen prompt.

import { z } from 'zod';
import { buildTool } from '@/core/tool-system';
import type { ToolDefinition } from '@/core/types';
import {
  runContentValidators,
  buildRepairPrompt,
  summarizeFailures,
  type ContentValidatorFailure,
  type ContentValidatorWarning,
} from '@/lib/content/validators';
import { listPlatforms } from '@/lib/platform-config';

export const VALIDATE_DRAFT_TOOL_NAME = 'validate_draft';

export const validateDraftInputSchema = z
  .object({
    text: z.string().min(1, 'text is required'),
    platform: z
      .string()
      .min(1, 'platform is required')
      .refine(
        (p) => listPlatforms().includes(p),
        (p) => ({
          message:
            `unknown platform "${p.toString()}" — must be one of: ` +
            listPlatforms().join(', '),
        }),
      ),
    kind: z.enum(['post', 'reply']),
    /**
     * X reply only — when the body will be sent as a reply that Twitter
     * auto-prepends with `@author`, leading `@handle` runs are excluded
     * from the 280-char cap. Pass `true` to strip them before measuring.
     * Default false; most agent drafts don't include the auto-mention prefix.
     */
    hasLeadingMentions: z.boolean().optional(),
  })
  .strict();

export type ValidateDraftInput = z.infer<typeof validateDraftInputSchema>;

export interface ValidateDraftResult {
  ok: boolean;
  failures: ContentValidatorFailure[];
  warnings: ContentValidatorWarning[];
  /**
   * One-line summary of failures (empty string when none) — useful for
   * logging and surfacing to the founder in the review UI.
   */
  summary: string;
  /**
   * Pre-built repair instruction the calling agent can prepend to its
   * regen prompt. Empty string when there's nothing to repair.
   */
  repairPrompt: string;
}

export const validateDraftTool: ToolDefinition<
  ValidateDraftInput,
  ValidateDraftResult
> = buildTool({
  name: VALIDATE_DRAFT_TOOL_NAME,
  description:
    'Validate a draft post or reply BEFORE persisting it. Returns ' +
    'structured pass/fail across platform-hard rules (length with ' +
    'twitter-text weighting on X, sibling-platform leak, unsourced stats) ' +
    'and ShipFlare-style warnings (hashtag count, links in body/reply, ' +
    'anchor token). Returns a `repairPrompt` you can feed straight back ' +
    'into your next regen turn. Read-only — no DB writes. Safe to call in ' +
    'parallel for distinct drafts. Call this AFTER drafting and BEFORE ' +
    'draft_reply / draft_post so platform rejections never reach the ' +
    'review queue.',
  inputSchema: validateDraftInputSchema,
  isConcurrencySafe: true,
  isReadOnly: true,
  async execute(input): Promise<ValidateDraftResult> {
    const result = runContentValidators({
      text: input.text,
      platform: input.platform,
      kind: input.kind,
      hasLeadingMentions: input.hasLeadingMentions,
    });

    const summary =
      result.failures.length > 0 ? summarizeFailures(result.failures) : '';
    const repairPrompt =
      result.failures.length > 0 || result.warnings.length > 0
        ? buildRepairPrompt(result.failures, input.platform, result.warnings)
        : '';

    return {
      ok: result.ok,
      failures: result.failures,
      warnings: result.warnings,
      summary,
      repairPrompt,
    };
  },
});
