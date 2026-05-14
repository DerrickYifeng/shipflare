// `SqlStorage` is a global type from `@cloudflare/workers-types` (not
// re-exported by `cloudflare:workers`). No import needed.

/**
 * Apply the CMO Durable Object's SQLite schema.
 *
 * Called from `CMO.onStart()` to ensure the schema is in place before any
 * request handler runs. `CREATE TABLE IF NOT EXISTS` makes this idempotent
 * across DO restarts. Per Agents SDK contract, `onStart` runs once per DO
 * lifetime under an implicit `blockConcurrencyWhile`, so no outer wrap is
 * needed here.
 *
 * Schema source of truth: migration design spec §4.2.3.
 *
 * SQLite types only — no Postgres-isms (no SERIAL / TIMESTAMP WITH TIME
 * ZONE / JSONB). `INTEGER` epoch millis stand in for timestamps; `_json`
 * suffix marks columns holding JSON-encoded TEXT.
 */
export function applyCmoSchema(sql: SqlStorage): void {
  sql.exec(`
    -- Founder conversations (Claude.ai-style chat scope, per spec D11)
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      title TEXT,
      archived INTEGER NOT NULL DEFAULT 0
    );

    -- Founder <-> CMO chat messages, scoped per conversation
    CREATE TABLE IF NOT EXISTS founder_messages (
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      ts INTEGER NOT NULL,
      tool_calls_json TEXT,
      meta_json TEXT,
      PRIMARY KEY (conversation_id, ts, role)
    );
    CREATE INDEX IF NOT EXISTS idx_messages_conv_ts
      ON founder_messages(conversation_id, ts);

    -- Identity-level KV: productName, productDescription, voice, audience, urls, etc.
    -- Persists across conversations (per spec D11).
    CREATE TABLE IF NOT EXISTS founder_context (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- Per-user employee roster (D12: dynamic hire on top of static role registry)
    CREATE TABLE IF NOT EXISTS roster (
      role TEXT PRIMARY KEY,
      hired_at INTEGER NOT NULL,
      status TEXT NOT NULL,
      hire_config_json TEXT
    );

    -- Strategic path versions (HoG generates, founder approves)
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

    -- Plan items - sprint work tickets. HoG writes, SMM/Copywriter execute.
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
  `);
}
