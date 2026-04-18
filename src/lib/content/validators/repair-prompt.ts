import { getPlatformCharLimits } from '@/lib/platform-config';
import type { ContentValidatorFailure } from './pipeline';

/**
 * Build a short, targeted repair prompt from a list of validator failures.
 * Fed back to the LLM as an additional user message on the retry pass so
 * the model knows exactly which constraint it broke last time.
 *
 * The output is a single concatenated string — caller decides how to inject
 * it (prepend to the user message, append to the system prompt, etc.).
 */
export function buildRepairPrompt(
  failures: ContentValidatorFailure[],
  platform: string,
): string {
  const instructions: string[] = [];

  for (const f of failures) {
    switch (f.validator) {
      case 'length': {
        instructions.push(
          `Your previous draft was ${f.length} characters but the limit is ` +
            `${f.limit}. Rewrite it to fit within ${f.limit} characters, ` +
            `preserving the core claim. Current overshoot: ${f.excess}.`,
        );
        break;
      }
      case 'platform_leak': {
        const leaked = f.leakedPlatforms.join(', ');
        instructions.push(
          `Your previous draft mentioned another platform (${leaked}) while ` +
            `writing for ${platform}. Remove every mention of ${leaked} unless ` +
            `you can fit a direct contrast ("unlike X", "vs X", "instead of X") ` +
            `inside a single sentence.`,
        );
        break;
      }
      case 'hallucinated_stats': {
        const claims = f.flaggedClaims.map((c) => `"${c}"`).join(', ');
        instructions.push(
          `Your previous draft contained unsourced numeric claim(s): ${claims}. ` +
            `Remove each number unless you can add a real citation ` +
            `("according to", "per <Source>", "source:", a URL, or @handle) ` +
            `in the same sentence. Prefer removing the number over inventing ` +
            `a citation.`,
        );
        break;
      }
    }
  }

  return instructions.join('\n\n');
}

/**
 * Human-readable, one-line-per-failure summary used as the `failureReason`
 * stored on a draft row when regeneration exhausts retries.
 */
export function summarizeFailures(
  failures: ContentValidatorFailure[],
): string {
  return failures
    .map((f) => {
      switch (f.validator) {
        case 'length':
          return `too long (${f.length}/${f.limit}, +${f.excess})`;
        case 'platform_leak':
          return `mentions other platform(s): ${f.leakedPlatforms.join(', ')}`;
        case 'hallucinated_stats':
          return `unsourced stat(s): ${f.flaggedClaims.join(', ')}`;
      }
    })
    .join('; ');
}

/**
 * Convenience: expose the two X caps together for UI that needs to echo
 * the limit back to the user before sending a retry. Platform-agnostic
 * despite the name — just two char-limit lookups in one call.
 */
export function getPostAndReplyLimits(platform: string) {
  return {
    post: getPlatformCharLimits(platform, 'post'),
    reply: getPlatformCharLimits(platform, 'reply'),
  };
}
