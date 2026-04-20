// Feature flags for the onboarding surface.
//
// These exist so half-finished integrations can ship UI affordances behind
// a single source of truth. Flip the flag when the backend lands and the
// UI unlocks without hunting for other gates.

/** Reddit drafting is not wired end-to-end yet — see audit finding #13. */
export const REDDIT_DRAFT_ENABLED = false;
