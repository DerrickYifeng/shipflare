# /team Chat UX Audit — 2026-04-22

## Executive summary

Overall rating: **C+ / "functional but not conversational."** The shell is handsome (agent dots, delegation cards, status banner) but the *conversation* primitives lag ChatGPT/Claude.ai on three load-bearing axes. Sessions are indistinguishable from each other because titles are just trigger+timestamp — users can't find anything they sent yesterday. New-session blanks the pane but never focuses the composer and never offers a prompt to start with. And while a reply is being generated, the composer re-enables and the thread shows *nothing* — no typing indicator, no streaming text, no "working…" affordance in the stream itself. Everything else (auto-scroll, error state, mobile drawer, message actions, search, pin/rename/delete) is missing but secondary.

**Top 3 gaps (fix first):**
1. **Session titles are meaningless** — "Manual run · Today 2:14 PM" for every row. User can't scan history. (session-row.tsx:119-123)
2. **No streaming / typing indicator in the thread** — assistant replies appear as a finished message with no in-flight feedback. (conversation.tsx:219-226)
3. **New Session does not focus composer and has no empty-state prompt** — user hits "+ New session", the thread blanks, and they stare at a bare textarea. (team-desk.tsx:145-179, conversation.tsx:249-260)

**Recommended first wave:** auto-title sessions from first user brief, add a streaming indicator (bouncing dots + "working…" node when `isLive && lastNode.kind==='user'`), and make New Session imperatively focus the textarea while showing 3 suggestion chips in the empty state. All three are S-effort and unblock everything else.

---

## Gap table

| # | Dimension | Current | ChatGPT/Claude pattern | Sev | Effort | Fix sketch |
|---|---|---|---|---|---|---|
| 1 | **Session titles** | `triggerLabel` + `formatStart` — e.g. "Manual run · Today 2:14 PM". Goal subtitle is `session.goal` which is empty for manual runs (use-new-session.ts:42 sends `goal: ''`). | Auto-title from first user message, truncated ~40 chars. "Fix the Reddit sweep cadence" | **HIGH** | S | In `session-row.tsx:119-123` show first user message text instead of trigger. Persist a `title` on `team_runs` or derive client-side from first `user_prompt` in that runId. |
| 2 | **Streaming indicator** | `conversation.tsx:219-226` renders finished nodes only. `isConnected`/`reconnecting` chip is at the section header, not inline in the thread. No bouncing-dots node. | Three-dot "…" bubble pinned to bottom of thread while an assistant turn is pending. | **HIGH** | S | When `isLive && last node in selected run is a `user` or unanswered lead with pending delegation`, append a `<TypingIndicator />` node. |
| 3 | **New Session focus + empty state** | `handleNewSessionCreated` (team-desk.tsx:145) selects the run but never calls `textarea.focus()`. `EmptySession` (conversation.tsx:249-260) is one line of grey text, no suggestions. | Click "+ New Chat" → composer is focused, empty state shows 3-4 suggestion chips. | **HIGH** | S | Lift a `composerRef` through `TeamDesk` → `StickyComposer`; on `onCreated` call `.focus()`. Expand `EmptySession` with chips wired to set composer value. |
| 4 | **Session list organization** | Flat list, newest-first, max 264px tall (session-list.tsx:16). No time buckets, no pin/favorite. | ChatGPT groups: Today / Yesterday / Previous 7 Days / Previous 30 / Older. | MED | M | Group `sessions` by bucket before map in `session-list.tsx:145`. |
| 5 | **Session search** | None — no input at top of session list (session-list.tsx:110-156). | ChatGPT: ⌘K or search-chats field at top. Claude.ai: search icon in sidebar. | MED | M | Add `<input>` above scroll area; filter by title/goal client-side. |
| 6 | **Session actions** | None — no rename, pin, delete, archive, export. | Hover row → ⋯ menu: Rename, Share, Archive, Delete. | MED | M | Start with delete (and soft-delete). Rename requires (1). |
| 7 | **Message actions** | User bubble (user-message.tsx) has no copy/edit. Lead bubble (lead-message.tsx) has no copy/regenerate/thumbs. | Hover any message → copy icon; last user message has edit; last assistant has regenerate + thumbs. | MED | M | Add hover-only action row below each bubble. Regenerate requires server support. |
| 8 | **Auto-scroll + user-scroll-respect** | `threadRef.scrollIntoView` fires ONLY on `selectedRunId` change (conversation.tsx:90-96). On new SSE message there is **no** auto-scroll — user stares at old content until they manually scroll. | Auto-scroll to bottom on arrival; pause auto-scroll if user scrolled up; show "Jump to latest" pill when paused. | **HIGH** | M | Add `useAutoScroll(threadRef, messages)` hook with IntersectionObserver on sentinel at bottom. |
| 9 | **Send semantics** | Enter submits, Shift+Enter newline, ⌘/Ctrl+Enter also submits (sticky-composer.tsx:110-120). Send button is a grey circle when disabled; when submitting, `setSubmitting(true)` disables it but **no spinner** — just turns grey. | Submit shows spinner in the send button; at rest shows ↑ arrow filled. | LOW | S | Swap the ↑ svg for a small spinner while `submitting`. |
| 10 | **Error state** | Failed POST triggers a `toast()` (sticky-composer.tsx:83-95) — ephemeral. No inline retry, no sticky error bubble. | Inline red banner under the failed message with "Retry" + "Edit & retry". | MED | M | Add local `lastError` state; render a retriable inline row below the composer. |
| 11 | **Connection chip** | "Live / Reconnecting / Offline" in the section header (conversation.tsx:206-210). Small, corner, easy to miss. Composer is NOT disabled when offline — user can type and fire a doomed POST. | Claude.ai disables send when offline and surfaces a top-level banner. | MED | S | Pipe `isConnected` into `StickyComposer`, disable send + show inline "reconnecting…" when false. |
| 12 | **Mobile** | `team-desk.tsx:383-400` collapses the 3-col grid at ≤768px but LeftRail becomes `static` and stacks above the thread — **no drawer, no hamburger**. Composer grid also becomes single column which is fine, but the left rail eats the first viewport before the user ever sees the conversation. | Hamburger → drawer with backdrop. Composer docked to keyboard. | **HIGH** | M | Add mobile-only header + `<Sheet>` drawer; hide LeftRail by default < 768px. |
| 13 | **Keyboard nav** | Session rows are `<button>` so native tab works. No `⌘K` focus shortcut. No `⌘N` new-session. No J/K to navigate sessions. No focus-visible ring styling — `outline: 'none'` on AgentRow (agent-row.tsx:102). | ChatGPT: ⌘K command palette, ⌘⇧O new chat. | MED | M | Add a global `useHotkeys` hook; restore `:focus-visible` outlines. |
| 14 | **Relative timestamps don't auto-refresh** | `formatStart` computed on render (session-meta.ts:24-48). A row rendered at 2:00 PM still says "Today 2:00 PM" 3 hours later — not "2h ago." | ChatGPT shows smart relative time that re-renders every minute. | LOW | S | `useNow(60_000)` hook re-renders list; adopt `"2m ago / 1h ago / yesterday"` format. |
| 15 | **Delegation cards are always expanded** | `DelegationCard` (delegation-card.tsx:66-86) always renders the full task list. Each row is a button but the whole card has no collapse. | ChatGPT collapses tool use: "Used web_search" with chevron. | LOW | S | Wrap the `<ul>` in a `<details>` that opens by default on the active run and collapses for finished runs. |
| 16 | **Message density / max width** | Conversation section uses the center grid cell (full 1fr). No explicit max-width on bubble rows. On a wide monitor the lead message can stretch >900px, hurting readability. (conversation.tsx:98-102) | ChatGPT ≈720px, Claude ≈740px readable width. | MED | S | Cap the inner thread at `max-width: 740px; margin: 0 auto;` in `conversation.tsx:156-159`. |
| 17 | **Empty-team + empty-all states** | `NoTeamYet` (page.tsx:407-439) is good. `EmptyConversation` (conversation.tsx:233-247) is one grey line, no CTA, no chips. No onboarding for first-time users. | ChatGPT: centered logo + "How can I help?" + 4 suggestion chips. | MED | S | Promote `EmptyConversation` to a hero block with 3 suggestion chips that prefill the composer. |
| 18 | **Status overload** | User sees **five** competing status signals simultaneously: `StatusBanner` (Live pill + drafts/in-review/approved), Conversation header (Live chip + turns), SessionDivider (status badge per run), AgentRow (pulsing dot + pill), `TodaysOutput` (same counts as banner). | One primary status strip max; collapse roster status into a dot. | MED | M | Drop `TodaysOutput` counts that duplicate StatusBanner, or hide banner when a session is selected. |
| 19 | **Composer disabled during submit** | `disabled={submitting}` on textarea (sticky-composer.tsx:258) — user can't queue a second message or even select the text they just typed. Note: the textarea is disabled but value clears on success. | ChatGPT keeps input editable; only send is swapped to stop-icon. | LOW | S | Drop `disabled` on the textarea; keep only the send button swap. |
| 20 | **Avatar + name repetition** | Every lead message re-renders avatar + name + time (lead-message.tsx:74-92). No grouping of consecutive messages from same sender. | ChatGPT only shows avatar on first message in a streak. | LOW | M | Pass `isFirstInStreak` from conversation; suppress header when false. |

## Top 5 quick wins (HIGH impact + S effort)

1. **Auto-title sessions from first user brief** (Gap 1) — biggest readability upgrade per minute of work. Client-side: scan messages for `type==='user_prompt' && runId===s.id` and use that string.
2. **Typing indicator in-thread** (Gap 2) — three bouncing dots component, rendered when `isLive && selectedRun.status==='running' && last node is user/pending`. 30-minute fix.
3. **Focus composer on New Session + suggestion chips** (Gap 3) — `ref.current.focus()` + 3 chips ("Plan next week's posts", "Review Reddit threads I should reply to", "Draft a launch announcement"). 1-2 hours.
4. **Clamp thread max-width to 740px** (Gap 16) — single CSS line, massive readability win on desktop.
5. **Disable send when offline + keep textarea editable during submit** (Gaps 11 + 19) — one fix each, removes two silent UX traps.

## Deferrable (not first-wave)

- Rename / archive / delete sessions (Gap 6)
- Search sessions (Gap 5)
- Time-bucket grouping (Gap 4)
- Message copy/edit/regenerate (Gap 7)
- Keyboard shortcuts & command palette (Gap 13)
- Avatar streak grouping (Gap 20)
- Collapsible delegation cards (Gap 15)

## Recommended fix order — 3 independently shippable waves

**Wave 1 — Conversational fundamentals**
- Gap 1 Session titles (derive from first user_prompt)
- Gap 2 Typing indicator in thread
- Gap 3 Focus composer + empty state with chips
- Gap 8 Auto-scroll on new message with user-scroll-respect
- Gap 16 Clamp thread to ~740px

**Wave 2 — Trust + safety**
- Gap 10 Inline error state with retry
- Gap 11 Offline-aware composer
- Gap 17 Empty-team hero state
- Gap 18 Deduplicate status signals (drop either StatusBanner or TodaysOutput counts)
- Gap 12 Mobile drawer for LeftRail

**Wave 3 — History navigation + polish**
- Gap 4 Time-bucket session grouping
- Gap 5 Session search input
- Gap 6 Session actions (delete first, rename second)
- Gap 13 Keyboard shortcuts (⌘K focus, ⌘⇧O new session)
- Gap 14 Auto-refreshing relative timestamps
- Gap 7 Message actions (copy, edit last, regenerate last)
- Gap 15 Collapsible delegation cards
- Gap 20 Avatar streak grouping
