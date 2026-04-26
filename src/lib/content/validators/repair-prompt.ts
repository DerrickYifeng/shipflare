import { getPlatformCharLimits } from '@/lib/platform-config';
import type {
  ContentValidatorFailure,
  ContentValidatorWarning,
} from './pipeline';

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
  warnings: ContentValidatorWarning[] = [],
): string {
  const instructions: string[] = [];

  for (const f of failures) {
    switch (f.validator) {
      case 'length': {
        if (f.reason === 'too_many_segments') {
          instructions.push(
            `Your previous draft has ${f.segmentCount} thread segments — ` +
              `the platform allows at most 25 tweets per thread. Cut it down.`,
          );
          break;
        }
        if (f.isThread && f.segments && f.segments.length > 0) {
          const offending = f.segments.filter((s) => !s.ok);
          const lines = offending.map(
            (s) =>
              `  - tweet #${s.index + 1}: ${s.length}/${f.limit} chars ` +
              `(+${s.excess})`,
          );
          instructions.push(
            `Your previous draft thread has ${offending.length} tweet(s) ` +
              `over the ${f.limit}-char-per-tweet cap (twitter-text weighted: ` +
              `t.co URLs = 23, emoji = 2, CJK = 2):\n${lines.join('\n')}\n` +
              `Rewrite ONLY the offending tweets. Preserve the rest.`,
          );
        } else {
          instructions.push(
            `Your previous draft was ${f.length} characters but the limit is ` +
              `${f.limit}. Rewrite it to fit within ${f.limit} characters, ` +
              `preserving the core claim. Current overshoot: ${f.excess}.`,
          );
        }
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

  for (const w of warnings) {
    switch (w.validator) {
      case 'hashtag_count': {
        instructions.push(
          `Hashtag count is ${w.count} (${w.hashtags.join(' ')}); the ` +
            `target range for ${platform} is ${w.min}-${w.max}. ` +
            (w.count > w.max
              ? 'Drop the surplus.'
              : 'Add #buildinpublic plus 1 topical tag.'),
        );
        break;
      }
      case 'links_in_reply': {
        instructions.push(
          `Replies should not contain links (${w.urls.join(', ')}). Remove ` +
            `the URL — answer the OP without driving them off the platform.`,
        );
        break;
      }
      case 'links_in_post_body': {
        instructions.push(
          `Don't put links inside the post body (${w.urls.join(', ')}). ` +
            `Move the URL to the first-reply field; X penalizes reach on ` +
            `tweets that contain links.`,
        );
        break;
      }
      case 'anchor_token': {
        instructions.push(
          `The reply has no concrete anchor (number, proper noun, named ` +
            `tool, or timestamp). Add one specific detail or skip the reply.`,
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
          if (f.reason === 'too_many_segments') {
            return `too many thread tweets (${f.segmentCount}/25)`;
          }
          if (f.isThread && f.segments) {
            const overCount = f.segments.filter((s) => !s.ok).length;
            return `thread has ${overCount} over-cap tweet(s); worst ${f.length}/${f.limit}`;
          }
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
 * Convenience: expose the two caps together for UI that needs to echo
 * the limit back to the user before sending a retry. Platform-agnostic
 * despite the name — just two char-limit lookups in one call.
 */
export function getPostAndReplyLimits(platform: string) {
  return {
    post: getPlatformCharLimits(platform, 'post'),
    reply: getPlatformCharLimits(platform, 'reply'),
  };
}
