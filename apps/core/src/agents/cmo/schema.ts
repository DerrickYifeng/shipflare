// `SqlStorage` is a global type from `@cloudflare/workers-types` (not
// re-exported by `cloudflare:workers`). No import needed.

/**
 * Apply the CMO Durable Object's SQLite schema.
 *
 * Called from `CMO.ensureSchema()` to ensure the schema is in place before
 * any handler touches the per-team tables. `CREATE TABLE IF NOT EXISTS`
 * makes this idempotent across DO restarts.
 *
 * Post-Phase-5 changes (Task 5.1b of CF-native chat migration):
 *  - DROPPED: `founder_messages` — chat history is persisted by AIChatAgent's
 *    built-in `cf_ai_chat_agent_messages` table on first chat. Spec §2 confirms (Q3=B).
 *  - DROPPED: `roster` — per-user hiring retired. EMPLOYEE_REGISTRY is the
 *    static org chart; every peer always available via `consult`. queryRoster
 *    derives from the registry (Task #11, 2026-05-19).
 *  - DROPPED: `activity_events` — the bespoke activity feed is replaced by
 *    Analytics Engine via `writeAgentEvent` (Phase 0 telemetry).
 *
 * Post-Task-#11 (2026-05-19):
 *  - RESTORED: `conversations` — AIChatAgent's cf_ai_chat_agent_messages is
 *    one bag per DO; `useAgentChat({id})` doesn't partition storage. The
 *    founder UI needs an authoritative thread list, so we keep this small
 *    table on per-team SQLite. startNewConversation INSERTs; listConversations
 *    READs. Threads themselves are still rendered from the AIChatAgent bag
 *    (filtered client-side by id at render time).
 *
 * Tables retained:
 *  - founder_context           — identity-level KV (productName, voice...)
 *  - strategic_path            — versioned strategy from HoG consult
 *  - plan_items                — sprint work tickets
 *  - employee_log              — peer-DM shadows, task completions
 *  - approval_queue            — drafts pending founder approval
 *  - progress_snapshots        — KPI rollups for the lead's summarisation
 *  - cross_conversation_memory — opt-in long-term "Remember this" facts
 *  - push_subscriptions        — VAPID web-push subscriptions
 */
export function applyCmoSchema(sql: SqlStorage): void {
  sql.exec(`
    -- Identity-level KV: productName, productDescription, voice, audience, urls, etc.
    -- Persists across conversations (per spec D11).
    CREATE TABLE IF NOT EXISTS founder_context (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- Strategic path versions (HoG generates via consult; CMO approves)
    CREATE TABLE IF NOT EXISTS strategic_path (
      id TEXT PRIMARY KEY,
      version INTEGER NOT NULL,
      theme TEXT NOT NULL,
      narrative_json TEXT NOT NULL,
      status TEXT NOT NULL,
      generated_at INTEGER NOT NULL,
      generated_by TEXT NOT NULL,
      approved_at INTEGER,
      replaced_by TEXT
    );

    -- Plan items - sprint work tickets. CMO writes, peers execute.
    CREATE TABLE IF NOT EXISTS plan_items (
      id TEXT PRIMARY KEY,
      skill TEXT NOT NULL,
      channel TEXT NOT NULL,
      params_json TEXT NOT NULL,
      status TEXT NOT NULL,
      owner_role TEXT NOT NULL,
      scheduled_for INTEGER,
      started_at INTEGER,
      completed_at INTEGER,
      output_json TEXT,
      parent_id TEXT,
      plan_version INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_plan_status
      ON plan_items(status, owner_role);

    -- Employee -> CMO log (task completions, peer-DM shadows, requests for input)
    CREATE TABLE IF NOT EXISTS employee_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT,
      from_role TEXT NOT NULL,
      kind TEXT NOT NULL,
      summary TEXT,
      payload_json TEXT,
      ts INTEGER NOT NULL,
      notified_founder INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_emp_log_unnotified
      ON employee_log(notified_founder, ts);

    -- Drafts pending founder approval (mirrors live SMM drafts that hit 'ready')
    CREATE TABLE IF NOT EXISTS approval_queue (
      id TEXT PRIMARY KEY,
      draft_id TEXT NOT NULL,
      employee TEXT NOT NULL,
      kind TEXT NOT NULL,
      channel TEXT NOT NULL,
      preview TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      decided_at INTEGER,
      decision TEXT
    );

    -- Rolling KPI / progress snapshots for the lead's summarization
    CREATE TABLE IF NOT EXISTS progress_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      posts_drafted INTEGER NOT NULL DEFAULT 0,
      posts_published INTEGER NOT NULL DEFAULT 0,
      replies_drafted INTEGER NOT NULL DEFAULT 0,
      replies_published INTEGER NOT NULL DEFAULT 0,
      json TEXT
    );

    -- P2-D: Cross-conversation memory (opt-in, Claude.ai-style "Remember this").
    -- Founder explicitly opts a fact in via the chat UI; we inject every active
    -- row into the system prompt of subsequent chat turns regardless of
    -- conversationId. Soft-delete (active=0) keeps audit trail.
    CREATE TABLE IF NOT EXISTS cross_conversation_memory (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      source_conversation_id TEXT,
      source_message_ts INTEGER,
      added_at INTEGER NOT NULL,
      active INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_memory_active
      ON cross_conversation_memory(active, added_at);

    -- P2-F: Web push subscriptions for browser notifications.
    -- The browser subscribes via the Push API, sends the resulting
    -- endpoint + keys to /api/push/subscribe (apps/web), which forwards
    -- to /internal/push-subscribe on the CMO DO. Endpoint is the primary
    -- key because Push protocol uniqueness is per-endpoint URL.
    --   last_error: last non-2xx HTTP status from the push service, e.g.
    --     "410" → subscription is dead (caller deletes the row); "5xx"
    --     → transient (we keep + retry).
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint TEXT PRIMARY KEY,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      subscribed_at INTEGER NOT NULL,
      last_used INTEGER,
      last_error TEXT
    );

    -- Founder-facing conversation thread list (Task #11, 2026-05-19).
    -- AIChatAgent stores all messages in one cf_ai_chat_agent_messages bag
    -- per DO; this table is the authoritative thread index the /team UI
    -- enumerates via listConversations. startNewConversation INSERTs a row;
    -- the resulting id is passed to useAgentChat({id}) so the client can
    -- key its message-list rendering.
    CREATE TABLE IF NOT EXISTS conversations (
      id           TEXT PRIMARY KEY,
      started_at   INTEGER NOT NULL,
      ended_at     INTEGER,
      title        TEXT,
      archived_at  INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_conversations_active
      ON conversations(archived_at, started_at DESC);
  `);
}
