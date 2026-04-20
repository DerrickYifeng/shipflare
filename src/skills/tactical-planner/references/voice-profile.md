# Voice profile

> Placeholder. Filled per-user at runtime by the skill caller — see
> `src/lib/voice/inject.ts`. When this file is injected with real content,
> it contains the user's markdown style card from `voice-extractor` plus
> the detected banned-phrase list. When the user hasn't run a voice scan,
> the caller replaces this file's contents with an empty string.

## How the planner uses voice

- `thesis` and `plan.notes` should sound like the founder, not like a
  marketing brief. When this card is present, use its pronoun stance
  (I vs we), typical sentence length, and signature phrases.
- Do NOT copy the style card's example phrases verbatim into plan
  output — the card shows the shape, not the content.
- Banned-phrase list applies to everything the planner emits
  (descriptions, notes, titles). If a phrase is in the user's banned
  list, do not use it.

## When voice is absent

- Write in a neutral founder register. Prefer "we" over "I" unless
  the product is obviously solo-branded (a personal handle as the
  product name).
- Keep `plan.notes` under 600 chars — less room to drift into
  generic voice without a real profile to anchor on.
