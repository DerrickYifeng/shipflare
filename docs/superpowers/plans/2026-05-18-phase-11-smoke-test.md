# Phase 11 — Smoke + cutover (manual, on staging)

**Date:** 2026-05-18
**Branch:** `dev` (Phase 7 just merged at `5baa733d`)
**Goal:** Validate that the CF-native chat migration + Phase 7 external MCP work end-to-end against real staging infra with the user's actual session.

---

## Pre-conditions (assumed)

- User logged into staging in their default browser
- User account exists in staging D1 (`users` table)
- Cloudflare account auth available locally (wrangler can deploy)
- Anthropic API key set as staging secret (`wrangler secret put ANTHROPIC_API_KEY --env staging`)

If any of these are missing, the test stops with a clear diagnostic.

---

## Test plan

### Stage A — Backend readiness (no UI yet)

| # | Step | Acceptance | Tool |
|---|---|---|---|
| A1 | Confirm staging deploy URL + Workers binding | URL in `apps/core/wrangler.jsonc` env.staging routes | Bash |
| A2 | Deploy `apps/core` to staging | `wrangler deploy --env staging` exits 0; reports a *.workers.dev URL | Bash |
| A3 | Smoke `/healthz` | Returns 200 | Bash + curl |
| A4 | Smoke `/.well-known/oauth-authorization-server` | Returns JSON with `authorization_endpoint`, `token_endpoint`, `scopes_supported: ["cmo:chat"]` | Bash + curl + jq |
| A5 | Smoke `/cmo/mcp` without Bearer | Returns 401 | Bash + curl |
| A6 | Write `scripts/verify-telemetry.ts` (Phase 11.1) | TypeScript file at repo root | Write tool |

**If A2 fails**: usually missing secrets or KV namespace not bound. Inspect wrangler output, fix, retry.

### Stage B — Claude Desktop config

| # | Step | Acceptance | Tool |
|---|---|---|---|
| B1 | Confirm Claude Desktop installed | `Claude.app` in `/Applications/` | Bash |
| B2 | Locate config path | `~/Library/Application Support/Claude/claude_desktop_config.json` | Bash |
| B3 | Snapshot current config | Show contents (or report no existing file) | Read tool |
| B4 | Edit config to add `shipflare-cmo` MCP server | New entry uses `npx mcp-remote <staging URL>/cmo/mcp` | Edit/Write tool |
| B5 | Verify JSON is valid | `python3 -m json.tool <path>` exits 0 | Bash |

**Do not** remove the user's existing MCP servers — append only.

### Stage C — OAuth dance + chat smoke (computer-use)

| # | Step | Acceptance | Tool |
|---|---|---|---|
| C1 | `request_access` for Claude (and any related apps the OAuth flow opens) | User approves | computer-use |
| C2 | Open Claude Desktop | App opens; screenshot shows the chat window | open_application + screenshot |
| C3 | Verify `shipflare-cmo` MCP server is loaded | Check the MCP indicator (usually bottom of input box) shows the new server with a count of 1 tool | screenshot + zoom |
| C4 | Trigger the OAuth dance | Either type "ask shipflare cmo what to do today" in Claude OR click the MCP tool icon. **First call** triggers OAuth → opens system browser tab with `/authorize` | type + screenshot |
| C5 | Browser opens — confirm consent screen renders | Screenshot the browser tab showing the `<h1>Authorize Claude Desktop?</h1>` consent page from `apps/core/src/external/auth-handler.ts` | screenshot |
| C6 | **User clicks Authorize** | Browser is tier "read" — cannot click via computer-use. Pause + ask user to click. After click, page redirects to `localhost:<port>/callback` (mcp-remote local callback) | screenshot before + after click |
| C7 | Return to Claude Desktop | Claude streams the assistant reply (the response from CMO's `chat` tool) | screenshot |
| C8 | Verify reply contents | Reply text contains plausible CMO content (mentions product/drafts/plan) | zoom on reply |

**If C5 returns 401 / 500**: `resolveUserIdFromSessionCookie` failed → user wasn't logged into staging in default browser, or Service Binding to apps/web is misconfigured. Diagnose via wrangler tail logs.

### Stage D — Telemetry verification

| # | Step | Acceptance | Tool |
|---|---|---|---|
| D1 | Get the test user's userId | Check apps/web `/api/user` or query D1 directly | Bash |
| D2 | Run `verify-telemetry.ts <userId>` | Script reports ≥ 1 `agent_run` row in last 5min | Bash |
| D3 | Verify blob1 includes `'CMO'` + the relay/external paths | Output contains `external-mcp` or `relay-fired` or `agent_run` | grep output |

### Stage E — Founder walkthrough on web UI

Per Phase 11.2 of the original plan:

| # | Step | Acceptance | Tool |
|---|---|---|---|
| E1 | Navigate to staging web UI `/chat` in user's browser | Page loads | (manual — browser is tier "read") |
| E2 | Send a short chat message | Assistant streams a reply | (user action) |
| E3 | Verify reasoning blocks render | "Thinking..." or reasoning panel visible | screenshot |
| E4 | If the LLM calls `consult`, verify nested run visibility | HoG/SMM consult shows up as a sub-run in UI | screenshot |
| E5 | Page reload mid-turn | Conversation state restored, no broken parts | screenshot |

---

## Stop conditions

The test stops (and we file a bug instead of merging further) if:

1. **A2 fails** — staging deploy errors (secrets, bindings).
2. **C5 returns non-200** — OAuth consent screen broken.
3. **C7 shows no reply** — chat tool flow broken end-to-end.
4. **D2 returns 0 rows** — telemetry pipeline broken.
5. **E2 fails** — web UI regression (shouldn't happen since 5.1c is already on dev).

---

## Output

After the test:
- All screenshots saved under `/tmp/phase-11-smoke/`
- A short report in `docs/superpowers/plans/2026-05-18-phase-11-smoke-RESULTS.md` with PASS/FAIL per step + screenshot paths
- If all PASS: the migration project is COMPLETE; nothing else blocks.
- If any FAIL: file a bug per affected stage and pause before retrying.

---

## Execution order

A1 → A2 → A3 → A4 → A5 → A6 → B1 → B2 → B3 → B4 → B5 → C1 → C2 → C3 → C4 → C5 → **PAUSE FOR USER TO CLICK AUTHORIZE** → C6 → C7 → C8 → D1 → D2 → D3 → E1-E5 (optional, depends on user availability).
