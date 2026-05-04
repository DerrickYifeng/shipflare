/**
 * Maps `slopFingerprint[]` from validating-draft to a one-line voice cue
 * the next drafting-reply/drafting-post fork should use as its `voice` arg.
 *
 * Single source of truth for "what to tell the writer when REVISE fires" —
 * keeps the orchestrating tool deterministic (no LLM in the retry decision).
 */

const CUES = {
  diagnostic_from_above:
    "drop the diagnostic 'the real thing is...' frame; lead with a first-person specific from your own run",
  no_first_person:
    "every generalized claim needs an I/we + concrete number/year/tool anchor — add one or rewrite as a specific question",
  binary_not_x_its_y:
    "remove the 'X isn't Y, it's Z' aphorism template — rewrite as a single concrete observation",
  preamble_opener:
    "remove the generic opener (no 'great post', 'as a founder', etc.) — open with the specific anchor",
  banned_vocabulary:
    'rewrite without leverage/delve/utilize/robust/crucial/pivotal/landscape/ecosystem/journey/seamless/navigate/compelling — use concrete verbs',
  engagement_bait_filler:
    'the draft is filler — write a substantive reply with a first-person anchor or skip the thread',
  fortune_cookie_closer:
    "drop the closer aphorism (`that's the moat/game/trick/...`) — let the concrete anchor carry the weight",
  colon_aphorism_opener:
    'remove the colon-as-wisdom opener — replace with the specific anchor mid-sentence',
  naked_number_unsourced:
    'every number needs a first-person grounding (how I measured it / when it happened / the tool I used)',
  em_dash_overuse:
    'rewrite using two short sentences instead of multiple em-dashes — at most one per reply',
  triple_grouping:
    'drop the triple grouping (X, Y, and Z) — pick one and earn it with a number',
  negation_cadence:
    "drop the rhythmic 'no X. no Y.' — replace with one specific receipt",
} as const;

export const KNOWN_FINGERPRINTS = Object.keys(CUES) as (keyof typeof CUES)[];

const GENERIC_CUE =
  'tighten the draft — first-person specific, no aphorisms, no banned vocabulary';

export function mapSlopFingerprintToVoiceCue(fingerprints: string[]): string {
  const matched = fingerprints
    .filter((fp): fp is keyof typeof CUES => fp in CUES)
    .map((fp) => CUES[fp]);

  if (matched.length === 0) return GENERIC_CUE;
  if (matched.length === 1) return matched[0];

  const combined = `Address each issue: ${matched.map((c, i) => `(${i + 1}) ${c}`).join('; ')}`;
  return combined.length > 900 ? combined.slice(0, 897) + '...' : combined;
}
