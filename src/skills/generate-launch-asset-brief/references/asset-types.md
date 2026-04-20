# Launch asset types

Constraints + anti-patterns per `assetType`.

## gallery_image

Dimensions: 1280x800 (PH gallery standard).

**Must-have constraints:**
- Product's actual UI visible (not a stock abstraction).
- High contrast between text and background.
- One outcome phrase overlaid max.

**Anti-patterns:**
- Generic gradient backgrounds with floating iPhone mockups.
- "Stock illustration" characters with purple skin.
- More than 8 words of text overlay.
- Empty screen frames with a tagline (no one cares what your skeleton
  looks like).

## video_30s

Runtime: 30 seconds. Captions required, VO optional.

**Must-have constraints:**
- Hook in first 3 seconds — a statement, not a logo reveal.
- Show the product doing the thing, not talking about the thing.
- End card has the tagline + launch date.

**Beat template:**
- 0-3s: hook frame (text overlay or one product screen).
- 3-8s: the problem the viewer recognizes.
- 8-16s: product reveal, actual UI.
- 16-26s: 2-3 outcome frames showing real output (drafts, metrics, etc.).
- 26-30s: end card.

**Anti-patterns:**
- Stock B-roll of people typing.
- Voiceover that sounds AI-read.
- Transitions that glue every scene with the same swipe.
- No captions — 80% of PH views are silent.

## og_image

Dimensions: 1200x630.

**Must-have constraints:**
- Readable at 600x315 (social preview scale). Font floor: 48px.
- Includes product name, one-line tagline, founder X handle.
- Brand colors only.

**Anti-patterns:**
- Full screenshot pasted in — illegible at thumbnail size.
- More than 12 words total.
- Photo of the founder in the OG image (save that for the maker comment).

## demo_gif

Dimensions: 800x500 or 960x600 typical. File size cap: 3MB (for GitHub
READMEs and landing embeds).

**Must-have constraints:**
- Shows one complete workflow start → end, not a teaser.
- Loopable: last frame transitions cleanly back to the first.
- Chrome dimmed or cropped when not load-bearing.

**Anti-patterns:**
- Cursor visible when not relevant to the action.
- Pauses longer than 600ms without a reason (they feel broken).
- Demos ending mid-action because "the rest is too long".

## Global anti-patterns (all types)

- Text that shifts between non-brand fonts mid-asset.
- Stock motion graphics (particle swarms, floating squares).
- AI-generated hands or crowds.
- More than 3 brand colors in a single frame.
- "Contact us to learn more" calls to action.

## referenceInspirations hygiene

- Only public URLs: PH launch pages, X posts, Vimeo / YouTube, Dribbble.
- Never: Figma files behind auth, Notion pages behind a share link that
  expires, Slack / Discord screenshots.
- Max 6 refs. Designers don't read 14 refs; they pick 1-2 to riff on.
