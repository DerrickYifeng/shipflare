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
