#!/usr/bin/env -S pnpm tsx
/**
 * verify-telemetry.ts — query Cloudflare Analytics Engine for recent agent
 * events written by ShipFlare's `writeAgentEvent` helper.
 *
 * Phase 11.1 of the CF-native chat migration. Used after a deploy or a
 * smoke session to confirm telemetry is flowing.
 *
 * Schema (per packages/shared/src/telemetry.ts):
 *   index1 = kind   ('agent_run' | 'tool_invocation' | 'skill_invocation')
 *   index2 = userId (the founder's ShipFlare user id)
 *   index3 = runId  (the per-LLM-turn run id; may be empty)
 *   blob1...blobN  = event-specific labels (e.g. ['CMO', 'relay-fired'])
 *   double1...     = event-specific numbers (e.g. duration ms)
 *
 * Usage:
 *   CF_ACCOUNT_ID=... CF_API_TOKEN=... \
 *     pnpm tsx scripts/verify-telemetry.ts <userId> [--dataset=<name>] [--window=<MIN>]
 *
 * Defaults:
 *   dataset = shipflare_agent_events_staging  (override for prod)
 *   window  = 10 (minutes)
 *
 * Exits 0 if at least one row found in the window, non-zero otherwise.
 */

const ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const API_TOKEN = process.env.CF_API_TOKEN;
if (!ACCOUNT_ID || !API_TOKEN) {
  console.error("Missing CF_ACCOUNT_ID and/or CF_API_TOKEN env vars.");
  console.error("Get from https://dash.cloudflare.com/profile/api-tokens");
  console.error("Token needs Account → Analytics → Read.");
  process.exit(2);
}

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith("--"));
const flags = Object.fromEntries(
  args
    .filter((a) => a.startsWith("--"))
    .map((a) => {
      const [k, v] = a.replace(/^--/, "").split("=");
      return [k, v ?? "true"];
    }),
);

const userId = positional[0];
if (!userId) {
  console.error("Usage: verify-telemetry.ts <userId> [--dataset=name] [--window=MINUTES]");
  process.exit(2);
}

const dataset = flags.dataset ?? "shipflare_agent_events_staging";
const windowMin = Number(flags.window ?? "10");
if (!Number.isFinite(windowMin) || windowMin <= 0) {
  console.error(`Invalid --window: ${flags.window}`);
  process.exit(2);
}

// Analytics Engine SQL — group by kind + blob1 (typically the role / agent).
// `dataset` is interpolated as the FROM table; userId is bound via string
// interpolation with quote-escaping (no parameterized API; this is the
// documented pattern).
const escUserId = userId.replace(/'/g, "''");
const sql = `
  SELECT
    index1 AS kind,
    blob1 AS role,
    blob2 AS label,
    COUNT(*) AS n,
    MAX(timestamp) AS most_recent
  FROM ${dataset}
  WHERE index2 = '${escUserId}'
    AND timestamp > NOW() - INTERVAL '${windowMin}' MINUTE
  GROUP BY kind, role, label
  ORDER BY most_recent DESC
  LIMIT 50
`;

const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/analytics_engine/sql`;

console.log(`Querying ${dataset} for userId=${userId} window=${windowMin}min...`);

let res: Response;
try {
  res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      "content-type": "text/plain",
    },
    body: sql,
  });
} catch (err) {
  console.error("Network error:", err);
  process.exit(3);
}

if (!res.ok) {
  console.error(`HTTP ${res.status} from Analytics Engine SQL API:`);
  console.error(await res.text());
  process.exit(3);
}

interface SqlResponse {
  meta?: Array<{ name: string; type: string }>;
  data?: Array<Record<string, string | number>>;
  rows?: number;
}

const body = (await res.json()) as SqlResponse;
const rows = body.data ?? [];

if (rows.length === 0) {
  console.error(`FAIL: 0 rows in last ${windowMin} minutes for userId=${userId}.`);
  console.error("Either the founder hasn't interacted with the agent recently,");
  console.error("or telemetry isn't flowing. Check apps/core wrangler.jsonc for");
  console.error("`analytics_engine_datasets` binding under env.staging.");
  process.exit(1);
}

console.log(`PASS: ${rows.length} aggregation row(s) found.`);
console.log();
console.log(JSON.stringify(rows, null, 2));

// Sanity checks
const kinds = new Set(rows.map((r) => String(r.kind ?? "")));
const sawAgentRun = kinds.has("agent_run");
console.log();
console.log(`Kinds seen: ${[...kinds].join(", ") || "(none)"}`);
console.log(`agent_run present: ${sawAgentRun ? "yes" : "no"}`);

process.exit(0);
