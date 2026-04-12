# ShipFlare Design System

## Direction

Light minimalist. Notion meets Linear. Dense but readable. Swiss/International typography influence. No decorative elements. Cards earn their existence.

Approved mockup: `~/.gstack/projects/DerrickYifeng-shipflare/designs/dashboard-variants-20260411/remix-final.png`

## Color Palette

```css
:root {
  /* Backgrounds */
  --sf-bg-primary: #ffffff;
  --sf-bg-secondary: #f8f8f8;
  --sf-bg-tertiary: #f0f0f0;

  /* Borders */
  --sf-border: #e5e5e5;
  --sf-border-subtle: #f0f0f0;

  /* Text */
  --sf-text-primary: #1a1a1a;
  --sf-text-secondary: #666666;
  --sf-text-tertiary: #767676;

  /* Accent */
  --sf-accent: #ff6b35;
  --sf-accent-hover: #e55a2b;
  --sf-accent-light: #fff5f0;

  /* Semantic */
  --sf-success: #16a34a;
  --sf-success-light: #f0fdf4;
  --sf-warning: #d97706;
  --sf-warning-light: #fffbeb;
  --sf-error: #dc2626;
  --sf-error-light: #fef2f2;
}
```

## Typography

```css
:root {
  --sf-font-heading: 'Space Grotesk', sans-serif;
  --sf-font-body: 'Space Grotesk', sans-serif;
  --sf-font-mono: 'JetBrains Mono', monospace;

  --sf-text-xs: 11px;
  --sf-text-sm: 13px;
  --sf-text-base: 15px;
  --sf-text-lg: 18px;
  --sf-text-xl: 24px;
  --sf-text-2xl: 32px;

  --sf-leading-tight: 1.1;
  --sf-leading-snug: 1.2;
  --sf-leading-normal: 1.4;
  --sf-leading-relaxed: 1.5;
  --sf-leading-loose: 1.6;
}
```

**Usage:**
- Headings: Space Grotesk, `--sf-text-lg` to `--sf-text-xl`
- Body text: Space Grotesk, `--sf-text-base`
- Labels/meta: Space Grotesk, `--sf-text-sm`
- Data/metrics/scores: JetBrains Mono, `--sf-text-sm` to `--sf-text-2xl`
- Badges/timestamps: `--sf-text-xs`

## Spacing

4px base unit.

```css
:root {
  --sf-space-1: 4px;
  --sf-space-2: 8px;
  --sf-space-3: 12px;
  --sf-space-4: 16px;
  --sf-space-5: 20px;
  --sf-space-6: 24px;
  --sf-space-8: 32px;
}
```

## Border Radius

```css
:root {
  --sf-radius-sm: 4px;   /* badges, pills */
  --sf-radius-md: 6px;   /* cards, buttons */
  --sf-radius-lg: 8px;   /* modals, panels */
  --sf-radius-full: 9999px; /* circles */
}
```

## Animation

```css
:root {
  --sf-duration-fast: 150ms;
  --sf-duration-normal: 200ms;
  --sf-duration-slow: 400ms;
  --sf-duration-score: 600ms;
  --sf-ease-out: cubic-bezier(0.16, 1, 0.3, 1);
}
```

Respect `prefers-reduced-motion: reduce`. Replace all animations with instant state changes.

## Layout

| Element | Value |
|---------|-------|
| Sidebar width | 200px (collapses to 48px icon rail at 1024px) |
| Draft Queue | 60% of main content |
| Discovery Feed | 40% of main content |
| Activity Timeline | 140px height (100px at 1024px) |
| Draft card gap | 8px |
| Thread row gap | 4px |
| Health Score ring | 36px diameter (compact header version) |

## Responsive Breakpoints

| Breakpoint | Layout |
|------------|--------|
| 1440px+ | Full sidebar + 60/40 split + bottom timeline |
| 1024px | Icon-only sidebar rail + 60/40 split |
| 768px | Top nav bar + stacked columns (Draft Queue first) |
| 375px | Top nav + bottom tab bar + single column views |

## Accessibility

- All interactive elements: 44px minimum touch target
- Color contrast: WCAG AA (4.5:1 normal text, 3:1 large text)
- Tertiary text (#767676) on white: 4.5:1 (WCAG AA compliant)
- Accent (#ff6b35) on white: 3.6:1 (large text/UI components only, not body text)
- Keyboard navigation with visible focus ring (2px accent, 2px offset)
- `prefers-reduced-motion` respected
- ARIA landmarks on all major sections

## Theme

Light only for Phase 1. CSS variables structured for dark mode addition in Phase 2 via `data-theme="dark"` attribute overriding `--sf-bg-*` and `--sf-text-*` variables.

## Landing Page Layout

Approved mockup: `~/.gstack/projects/DerrickYifeng-shipflare/designs/landing-page-20260411/variant-C.png`

**Flow:** Value-first funnel. No sign-in required to scan. Product demo IS the pitch.

### Hero Section
- Centered layout, max-width 640px
- Headline: `--sf-text-2xl`, font-weight 700, `--sf-text-primary`
- Subline: `--sf-text-base`, `--sf-text-secondary`
- Search input: full-width, `--sf-radius-md` border, `--sf-border` stroke
- CTA button: `--sf-accent` background, white text, `--sf-radius-md`, "Scan"
- Minimal header: Logo + tagline + contextual nav (Dashboard if auth, Sign in if unauth).

### Discovery Cards
- Source-agnostic design (Reddit, HN, Twitter, ProductHunt...)
- Each card contains:
  - Source icon (16px) + platform name (`--sf-text-xs`, `--sf-text-tertiary`)
  - Thread title (`--sf-text-base`, `--sf-text-primary`, font-weight 500)
  - Relevance score (0-100) in `--sf-font-mono`, with score ring (24px diameter)
  - Upvote count + comment count (`--sf-text-sm`, `--sf-text-secondary`)
  - Topic/subreddit tag pill (`--sf-text-xs`, `--sf-bg-tertiary`, `--sf-radius-sm`)
  - Time ago (`--sf-text-xs`, `--sf-text-tertiary`)
- Card gap: 4px (tight stacking, border-bottom separation)
- Card padding: 12px 16px

### Blur Wall
- First 3 cards: fully visible, interactive
- Cards 4+: `backdrop-filter: blur(8px)`, `pointer-events: none`
- Gradient overlay: white to transparent, top-to-bottom over blurred section
- CTA overlay: centered "Sign in to unlock all results" (`--sf-text-base`, `--sf-text-primary`)
- GitHub OAuth button below CTA text
- After sign-in: blur removes, all cards visible, "Go to Dashboard" CTA appears

### No Marketing Sections
- No "How it works", no feature grids, no testimonials below the fold
- The scan results ARE the pitch. 3 real cards from the user's own product URL.

### Thought Stream (Agent Workflow Visualization)

Replaces skeleton loaders during scan. A JetBrains Mono block that streams the AI agent's work in real-time. Not a chatbot. More like watching terminal output.

**Container:**
- `--sf-bg-secondary` background, `--sf-border` 1px stroke, `--sf-radius-lg`
- Padding: 16px 20px
- Max-width: 640px (same as hero)
- Min-height: 120px to prevent layout shift

**Typography:**
- All text: `--sf-font-mono` (JetBrains Mono), `--sf-text-sm` (13px)
- Step labels: `--sf-text-tertiary`
- Keywords/search phrases: `--sf-accent` (#ff6b35)
- Completion checkmarks: `--sf-success` (#16a34a)
- Progress bar fill: `--sf-accent`

**Streaming steps:**

```
analyzing yourproduct.com...                       ✓
→ project management · issue tracking · dev tools

searching for conversations...
  "project management tools"                       ✓
  "issue tracking alternatives"                    ●
  "sprint planning small teams"

scoring relevance...                               ●
```

| Step | Trigger | Display |
|------|---------|---------|
| `analyzing {url}...` | Scan starts | URL in `--sf-text-primary`, rest in `--sf-text-tertiary` |
| `→ keyword · keyword · keyword` | Scrape completes | Keywords in `--sf-accent`, joined with ` · ` |
| `searching for conversations...` | Agent starts first tool call | Label in `--sf-text-tertiary` |
| `  "search phrase"` | Each `reddit_search` tool call | Phrase in `--sf-accent`, indented 2 spaces. Appears one-by-one as agent makes calls. `✓` suffix when call returns. `●` suffix while active. |
| `scoring relevance...` | Agent's final turn (no more tool calls) | `●` while scoring, `✓` when done |

**Animation:**
- New lines fade in: opacity 0→1, translateY(4px→0), 150ms `--sf-ease-out`
- Active indicator `●`: CSS pulse animation, 1.5s infinite, opacity 0.4→1.0
- Checkmark `✓`: instant replace of `●`, no transition
- Character-by-character typewriter on the `analyzing` line only: ~30ms/char
- All other lines appear as complete strings (typewriter on every line gets annoying)
- Respect `prefers-reduced-motion`: disable typewriter, instant line appearance

**Transition to results:**
- On completion: 400ms pause, then stream fades out (opacity 1→0, 200ms)
- Results container fades in immediately after (opacity 0→1, 200ms)
- No collapse/slide. Simple crossfade. Less is more.

**Progress bar (optional, right-aligned):**
- Thin bar (2px height) at bottom of container
- Fills left-to-right based on tool calls completed / total expected
- `--sf-accent` fill, `--sf-bg-tertiary` track
- Disappears with the container on completion

**Technical requirement:**
- `/api/scan` must stream SSE events instead of returning all-at-once
- Event types: `scrape_done`, `agent_thinking`, `tool_call_start`, `tool_call_done`, `scoring`, `complete`
- Each event carries minimal data (step name, keywords, search query, etc.)

## Decisions Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-04-11 | Initial design system created | Created by /design-consultation based on dashboard mockups |
| 2026-04-12 | Landing page redesign: value-first funnel | Replace sign-in gate with scan-first flow. Show 3 cards free, blur rest. Product demo is the pitch. |
| 2026-04-12 | Thought Stream: agent workflow visualization | Monospace terminal-style block showing AI work in real-time. Keywords + search phrases streamed via SSE. Builds trust through specificity. |
| 2026-04-12 | Landing page polish: icon, nav, empty state | Replaced Databricks-like stacked layers icon with flame/flare. Added contextual nav (Dashboard/Sign in). Vertically centered hero on empty state with subtle footer hints. |
