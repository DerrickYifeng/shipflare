# Commit signal patterns

Examples of how to read a window of git activity and decide what's worth
surfacing as a milestone — and when to return `null`.

## High-signal windows (select a milestone)

### Example A — release tag present

```
v0.9.0 "Beta launch"                         <- release
PR #124 "Add Reddit account connect flow"    <- feat
PR #122 "Onboarding v2 chrome"               <- feat
chore: bump deps
refactor: rename lifecycleField
```

Select: **the release tag**. `source: 'release'`, confidence 0.9.

```
milestone: {
  title: "Shipped beta — Reddit + onboarding v2 live",
  summary: "ShipFlare beta is out. Reddit account connect + the redesigned
    onboarding flow are the user-visible changes since the last release.",
  source: "release",
  sourceRef: "v0.9.0",
  confidence: 0.9
}
```

### Example B — feat without a release

```
PR #201 "Reply-guy engine: 15-min reply window for target accounts"
PR #198 "Fix drift on draft-review confidence scoring"
chore: deps
refactor: extract platform-config
```

Select: **PR #201**. `source: 'pr'`, confidence 0.85.

```
milestone: {
  title: "Reply-guy engine now watches target accounts and drafts replies within 15 minutes",
  summary: "New monitor surface picks tweets from a user's target list and
    fires reply drafts inside the 15-minute algorithmic window. Previously
    the reply pipeline only fired from bulk discovery runs.",
  source: "pr",
  sourceRef: "#201",
  confidence: 0.85
}
```

### Example C — fix as fallback

No feats in the window; one meaningful fix.

```
fix: draft-review confidence inverted in the WRITE path
chore: deps
refactor: rename slot-body -> draft-single-post
```

Select: **the fix**. `source: 'commit'`, confidence 0.5.

Summary should explain why the fix matters in user terms — "drafts that
should have been approved were getting flagged, skipping the review
stage" — not repeat the commit message.

## Low-signal windows (return null)

### Example D — chore only

```
chore: bump next 16.2.2 → 16.2.3
chore: update eslint
deps: upgrade drizzle
refactor: extract-helper
docs: update README
```

Return `{ milestone: null }`. Confidence irrelevant.

### Example E — all refactor

```
refactor: flatten components dir
refactor: pull out shared types
refactor: rename env var
```

Return `{ milestone: null }`. Don't dress a refactor as a "new internal
architecture" — readers won't care and the planner will build a thin
thesis.

## Confidence calibration

- **0.9+** — release tag or a PR that maps 1:1 to the product's headline
  value prop.
- **0.7-0.85** — feat PR / commit that adds a real capability, even if
  not the headline surface.
- **0.4-0.65** — fix with clear user impact, perf win with measured
  numbers, or feat for a secondary surface.
- **< 0.4** — drift into unclear territory. Consider returning null
  instead.

## Rules

- NEVER quote the commit message verbatim in `title`. Commits are terse;
  titles are human.
- When collapsing multiple related commits into one milestone, use the
  highest-level artifact as `sourceRef` (release tag > PR # > sha).
- When in doubt, pick the commit whose message explains an OUTCOME, not
  a mechanism. "Ship reply-guy engine" > "wire monitor processor to
  engagement queue".
- Return `null` WITHOUT a reason field. Consumers check `milestone ===
  null` — no narrative needed.
