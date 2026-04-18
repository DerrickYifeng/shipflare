/**
 * Shared content validators. Pure functions that inspect a draft and return
 * structured pass/fail — no side effects, no network, safe for use anywhere
 * (workers, routes, CLI, tests).
 *
 * The caller is responsible for deciding what to do with a failure
 * (retry the LLM, surface to the user, hard-block, etc.). See
 * `./pipeline.ts` for the aggregated runner.
 */

export {
  validateReplyLength,
  type ReplyLengthOptions,
  type ReplyLengthResult,
} from './length';

export {
  validatePlatformLeak,
  type PlatformLeakOptions,
  type PlatformLeakResult,
} from './platform-leak';

export {
  validateHallucinatedStats,
  type HallucinatedStatsResult,
} from './hallucinated-stats';

export {
  runContentValidators,
  type ContentValidatorInput,
  type ContentValidatorResult,
  type ContentValidatorFailure,
} from './pipeline';
