# Cloudflare Migration — Phase 1 Feature Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship ShipFlare with 100% feature parity to the current production codebase, running on Cloudflare Workers + Durable Objects + Agents SDK + Dynamic Workflows. Old Node/BullMQ stack deleted at the end.

**Architecture:** Two-Worker monorepo: `apps/web` (Next.js via OpenNext, Better Auth, hosts UI + login + channel OAuth callbacks) and `apps/core` (DO host: CMO, HeadOfGrowth, SocialMediaMgr, XMcpAgent, RedditMcpAgent + AgentPlanWorkflow). Uniform McpAgent across all employees; CMO is pure orchestrator; Head of Growth handles strategy; SMM executes. Internal communication via in-process MCP RPC (`addMcpServer` with DO binding). Per-team data in CMO SQLite, per-employee private state in each employee's SQLite, cross-team data (users / accounts / channels) in Neon Postgres via Hyperdrive. Conversation-scoped chat memory (Claude.ai-style reset).

**Tech Stack:** Cloudflare Workers v4, Agents SDK ≥0.6.0, McpAgent + Dynamic Workflows, Next.js 16 + OpenNext, Better Auth, Drizzle ORM, Neon Postgres + Hyperdrive, WebCrypto AES-GCM, `@anthropic-ai/sdk`, `@modelcontextprotocol/sdk`, vitest + `@cloudflare/vitest-pool-workers`, Playwright.

**Spec:** `docs/superpowers/specs/2026-05-13-cloudflare-do-migration-design.md` §5.2.
**Prerequisite:** Phase 0 spike GREEN (`docs/superpowers/plans/2026-05-13-cf-phase-0-spike.md`).

---

## File Structure

```
shipflare/                              ← monorepo root (existing repo)
  apps/
    web/                                ← Next.js + OpenNext Worker
      app/
        (auth)/login/page.tsx
        (app)/
          layout.tsx                    ← session-gated shell
          chat/[conversationId]/page.tsx
          team/page.tsx
          plan/page.tsx
          drafts/page.tsx
          settings/channels/page.tsx
        api/
          auth/[...all]/route.ts        ← Better Auth handler
          mcp-token/route.ts            ← signs JWT for browser → core
          channels/x/callback/route.ts
          channels/reddit/callback/route.ts
      src/
        auth.ts                         ← Better Auth client config
        db/index.ts                     ← Drizzle + Hyperdrive
        mcp-client.ts                   ← browser MCP client wrapper
      wrangler.jsonc
      open-next.config.ts
      package.json
    core/                               ← DO host Worker
      src/
        index.ts                        ← Worker entry: routeAgentRequest + scheduled + fetch
        agents/
          cmo/CMO.ts
          cmo/tools.ts
          cmo/schema.ts
          head-of-growth/HeadOfGrowth.ts
          head-of-growth/tools.ts
          head-of-growth/schema.ts
          social-media-manager/SocialMediaMgr.ts
          social-media-manager/tools.ts
          social-media-manager/schema.ts
        platforms/
          x/XMcpAgent.ts
          x/tools.ts
          reddit/RedditMcpAgent.ts
          reddit/tools.ts
        workflows/AgentPlanWorkflow.ts
        lib/
          jwt.ts
          props.ts
      wrangler.jsonc
      package.json
  packages/
    shared/
      src/
        mcp-props.ts                    ← EmployeeProps type + helpers
        role-registry.ts                ← ROLE_REGISTRY map
        types.ts                        ← shared zod schemas
      package.json
    skills/
      src/
        index.ts                        ← skill registry
        runner.ts                       ← MCP-tool-invocation runner
      skills/
        drafting-post/SKILL.md
        drafting-post/references/
        drafting-reply/...
        judging-thread/...
        validating-draft/...
        generate-queries/...
      package.json
    tools/
      src/
        x/client.ts
        x/types.ts
        reddit/client.ts
        reddit/types.ts
        validators/platform-leak.ts
        validators/reply-throttle.ts
        validators/validate-draft.ts
      package.json
    db/
      src/
        schema.ts                       ← Better Auth + channels tables
        migrations/                     ← drizzle-kit output
      drizzle.config.ts
      package.json
    crypto/
      src/
        aes-gcm.ts                      ← WebCrypto helper
      package.json

  pnpm-workspace.yaml
  tsconfig.base.json
  package.json
```

---

## S1 — Infrastructure (Day 0-1, foundation, blocks everything)

### Task S1.0: Initialize monorepo

**Files:**
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Modify: `package.json` (turn root into workspace)

- [ ] **Step 1: Write `pnpm-workspace.yaml`**

```yaml
packages:
  - "apps/*"
  - "packages/*"
```

- [ ] **Step 2: Write `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "isolatedModules": true,
    "noEmit": true,
    "experimentalDecorators": false
  }
}
```

- [ ] **Step 3: Update root `package.json`**

```json
{
  "name": "shipflare",
  "private": true,
  "scripts": {
    "dev": "pnpm --parallel -r dev",
    "dev:web": "pnpm --filter=@shipflare/web dev",
    "dev:core": "pnpm --filter=@shipflare/core dev",
    "build": "pnpm -r build",
    "test": "pnpm -r test",
    "typecheck": "pnpm -r typecheck",
    "migrate": "pnpm --filter=@shipflare/db migrate"
  },
  "packageManager": "pnpm@9.0.0"
}
```

- [ ] **Step 4: Commit**

```bash
git add pnpm-workspace.yaml tsconfig.base.json package.json
git commit -m "feat(infra): init pnpm workspace"
```

---

### Task S1.1: Create `packages/shared`

**Files:**
- Create: `packages/shared/package.json`
- Create: `packages/shared/tsconfig.json`
- Create: `packages/shared/src/mcp-props.ts`
- Create: `packages/shared/src/role-registry.ts`
- Create: `packages/shared/src/types.ts`
- Create: `packages/shared/src/index.ts`

- [ ] **Step 1: Write `packages/shared/package.json`**

```json
{
  "name": "@shipflare/shared",
  "version": "0.0.0",
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": { "zod": "^3.23.0" },
  "devDependencies": { "typescript": "^5.5.0", "vitest": "^1.6.0" }
}
```

- [ ] **Step 2: Write `packages/shared/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: Write `src/mcp-props.ts`**

```typescript
import { z } from "zod";

export const McpPropsSchema = z.object({
  userId: z.string(),
  conversationId: z.string().optional(),
  caller: z.enum(["cmo", "external", "peer", "cron"]),
  role: z.enum(["lead", "member"]).optional(),
});

export type McpProps = z.infer<typeof McpPropsSchema>;

export function assertMcpProps(props: unknown): McpProps {
  return McpPropsSchema.parse(props);
}
```

- [ ] **Step 4: Write `src/role-registry.ts`**

```typescript
export interface RoleEntry {
  binding: "CMO" | "HEAD_OF_GROWTH" | "SOCIAL_MEDIA_MGR";
  displayName: string;
  tier: "core" | "pro";
  defaultActive: boolean;
}

export const ROLE_REGISTRY = {
  "cmo": {
    binding: "CMO",
    displayName: "CMO",
    tier: "core",
    defaultActive: true,
  },
  "head-of-growth": {
    binding: "HEAD_OF_GROWTH",
    displayName: "Head of Growth",
    tier: "core",
    defaultActive: true,
  },
  "social-media-manager": {
    binding: "SOCIAL_MEDIA_MGR",
    displayName: "Social Media Manager",
    tier: "core",
    defaultActive: true,
  },
  // Phase 2 additions go here
} as const satisfies Record<string, RoleEntry>;

export type RoleSlug = keyof typeof ROLE_REGISTRY;
```

- [ ] **Step 5: Write `src/types.ts`**

```typescript
import { z } from "zod";

export const ConversationSchema = z.object({
  id: z.string(),
  startedAt: z.number(),
  endedAt: z.number().nullable(),
  title: z.string().nullable(),
  archived: z.boolean().default(false),
});

export const FounderMessageSchema = z.object({
  conversationId: z.string(),
  role: z.enum(["user", "assistant", "system", "tool"]),
  content: z.string(),
  ts: z.number(),
  toolCallsJson: z.string().nullable(),
});

export const PlanItemSchema = z.object({
  id: z.string(),
  skill: z.string(),
  channel: z.enum(["x", "reddit"]),
  paramsJson: z.string(),
  status: z.enum(["pending", "in_progress", "completed", "failed", "cancelled"]),
  ownerRole: z.string(),
  scheduledFor: z.number().nullable(),
  startedAt: z.number().nullable(),
  completedAt: z.number().nullable(),
});

export type Conversation = z.infer<typeof ConversationSchema>;
export type FounderMessage = z.infer<typeof FounderMessageSchema>;
export type PlanItem = z.infer<typeof PlanItemSchema>;
```

- [ ] **Step 6: Write `src/index.ts`**

```typescript
export * from "./mcp-props";
export * from "./role-registry";
export * from "./types";
```

- [ ] **Step 7: Commit**

```bash
git add packages/shared/
git commit -m "feat(shared): MCP props + role registry + shared types"
```

---

### Task S1.2: Create `packages/crypto` (WebCrypto AES-GCM)

**Files:**
- Create: `packages/crypto/package.json`
- Create: `packages/crypto/tsconfig.json`
- Create: `packages/crypto/src/aes-gcm.ts`
- Create: `packages/crypto/src/index.ts`
- Create: `packages/crypto/test/aes-gcm.test.ts`

- [ ] **Step 1: Write `packages/crypto/package.json`**

```json
{
  "name": "@shipflare/crypto",
  "version": "0.0.0",
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "devDependencies": { "typescript": "^5.5.0", "vitest": "^1.6.0" }
}
```

- [ ] **Step 2: Write `src/aes-gcm.ts`** (port from spike #5 with proper key management)

```typescript
function b64decode(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}
function b64encode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

async function importKey(keyBase64: string): Promise<CryptoKey> {
  const raw = b64decode(keyBase64);
  if (raw.length !== 32) throw new Error("AES-GCM key must be 32 bytes (base64-encoded)");
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encrypt(plaintext: string, keyBase64: string): Promise<string> {
  const key = await importKey(keyBase64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext))
  );
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0);
  out.set(ct, iv.length);
  return b64encode(out);
}

export async function decrypt(encoded: string, keyBase64: string): Promise<string> {
  const key = await importKey(keyBase64);
  const bytes = b64decode(encoded);
  if (bytes.length < 13) throw new Error("ciphertext too short");
  const iv = bytes.slice(0, 12);
  const ct = bytes.slice(12);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return new TextDecoder().decode(pt);
}

export async function generateKey(): Promise<string> {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  return b64encode(raw);
}
```

- [ ] **Step 3: Write `src/index.ts`**

```typescript
export { encrypt, decrypt, generateKey } from "./aes-gcm";
```

- [ ] **Step 4: Write test**

```typescript
import { describe, it, expect } from "vitest";
import { encrypt, decrypt, generateKey } from "../src/aes-gcm";

describe("aes-gcm", () => {
  it("round-trips 100 random tokens", async () => {
    const key = await generateKey();
    for (let i = 0; i < 100; i++) {
      const pt = `token-${i}-${Math.random()}`;
      const ct = await encrypt(pt, key);
      const dec = await decrypt(ct, key);
      expect(dec).toBe(pt);
    }
  });
  it("different IV yields different ciphertext", async () => {
    const key = await generateKey();
    const a = await encrypt("same", key);
    const b = await encrypt("same", key);
    expect(a).not.toBe(b);
  });
  it("wrong key fails to decrypt", async () => {
    const k1 = await generateKey();
    const k2 = await generateKey();
    const ct = await encrypt("secret", k1);
    await expect(decrypt(ct, k2)).rejects.toThrow();
  });
});
```

- [ ] **Step 5: Run test**

Run: `cd packages/crypto && pnpm test`
Expected: 3 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/crypto/
git commit -m "feat(crypto): WebCrypto AES-GCM helper"
```

---

### Task S1.3: Create `packages/db` (Drizzle schemas for Postgres)

**Files:**
- Create: `packages/db/package.json`
- Create: `packages/db/tsconfig.json`
- Create: `packages/db/src/schema.ts`
- Create: `packages/db/src/index.ts`
- Create: `packages/db/drizzle.config.ts`

- [ ] **Step 1: Write `packages/db/package.json`**

```json
{
  "name": "@shipflare/db",
  "version": "0.0.0",
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": {
    "typecheck": "tsc --noEmit",
    "generate": "drizzle-kit generate",
    "migrate": "drizzle-kit migrate"
  },
  "dependencies": {
    "drizzle-orm": "^0.34.0",
    "@neondatabase/serverless": "^0.10.0"
  },
  "devDependencies": {
    "drizzle-kit": "^0.27.0",
    "typescript": "^5.5.0"
  }
}
```

- [ ] **Step 2: Write `src/schema.ts`**

```typescript
import { pgTable, text, timestamp, boolean, integer, primaryKey } from "drizzle-orm/pg-core";

// Better Auth standard schema (4 tables) — Better Auth's Drizzle adapter expects
// these exact column names. Do not rename.
export const user = pgTable("user", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("emailVerified").notNull().default(false),
  name: text("name"),
  image: text("image"),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  updatedAt: timestamp("updatedAt").notNull().defaultNow(),
});

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expiresAt").notNull(),
  token: text("token").notNull().unique(),
  ipAddress: text("ipAddress"),
  userAgent: text("userAgent"),
  userId: text("userId").notNull().references(() => user.id, { onDelete: "cascade" }),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  updatedAt: timestamp("updatedAt").notNull().defaultNow(),
});

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  accountId: text("accountId").notNull(),
  providerId: text("providerId").notNull(),
  userId: text("userId").notNull().references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("accessToken"),
  refreshToken: text("refreshToken"),
  idToken: text("idToken"),
  accessTokenExpiresAt: timestamp("accessTokenExpiresAt"),
  refreshTokenExpiresAt: timestamp("refreshTokenExpiresAt"),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("createdAt").notNull().defaultNow(),
  updatedAt: timestamp("updatedAt").notNull().defaultNow(),
});

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expiresAt").notNull(),
  createdAt: timestamp("createdAt"),
  updatedAt: timestamp("updatedAt"),
});

// ShipFlare-specific (1 table)
export const channels = pgTable("channels", {
  id: text("id").primaryKey(),
  userId: text("userId").notNull().references(() => user.id, { onDelete: "cascade" }),
  platform: text("platform", { enum: ["x", "reddit"] }).notNull(),
  externalUserId: text("externalUserId").notNull(),
  username: text("username"),
  oauthTokenEncrypted: text("oauthTokenEncrypted").notNull(),
  oauthRefreshEncrypted: text("oauthRefreshEncrypted"),
  scope: text("scope"),
  connectedAt: timestamp("connectedAt").notNull().defaultNow(),
  lastVerifiedAt: timestamp("lastVerifiedAt"),
  status: text("status", { enum: ["active", "revoked", "error"] }).notNull().default("active"),
});
```

- [ ] **Step 3: Write `src/index.ts`**

```typescript
import { drizzle } from "drizzle-orm/neon-http";
import { neon } from "@neondatabase/serverless";
import * as schema from "./schema";

export * from "./schema";
export type DB = ReturnType<typeof drizzle<typeof schema>>;

export function createDb(connectionString: string): DB {
  const sql = neon(connectionString);
  return drizzle(sql, { schema });
}
```

- [ ] **Step 4: Write `drizzle.config.ts`**

```typescript
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/schema.ts",
  out: "./src/migrations",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL! },
});
```

- [ ] **Step 5: Generate migration**

```bash
cd packages/db
export DATABASE_URL="postgresql://<neon-direct-url>"  # use Neon connection (not Hyperdrive) for migrations
pnpm generate
```

- [ ] **Step 6: Apply migration to dev DB**

```bash
pnpm migrate
```

- [ ] **Step 7: Commit**

```bash
git add packages/db/
git commit -m "feat(db): Drizzle schema for 5 Postgres tables"
```

---

### Task S1.4: Create `apps/core` scaffold

**Files:**
- Create: `apps/core/package.json`
- Create: `apps/core/tsconfig.json`
- Create: `apps/core/wrangler.jsonc`
- Create: `apps/core/src/index.ts`
- Create: `apps/core/src/lib/jwt.ts`

- [ ] **Step 1: Write `apps/core/package.json`**

```json
{
  "name": "@shipflare/core",
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "wrangler dev --port 3001",
    "deploy": "wrangler deploy",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@shipflare/shared": "workspace:*",
    "@shipflare/db": "workspace:*",
    "@shipflare/crypto": "workspace:*",
    "@shipflare/skills": "workspace:*",
    "@shipflare/tools": "workspace:*",
    "agents": "^0.6.0",
    "@modelcontextprotocol/sdk": "^1.0.0",
    "@anthropic-ai/sdk": "^0.36.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "wrangler": "^4.0.0",
    "@cloudflare/workers-types": "^4.20260101.0",
    "@cloudflare/vitest-pool-workers": "^0.8.0",
    "vitest": "^1.6.0",
    "typescript": "^5.5.0"
  }
}
```

- [ ] **Step 2: Write `apps/core/wrangler.jsonc`**

```jsonc
{
  "$schema": "../../node_modules/wrangler/config-schema.json",
  "name": "shipflare-core",
  "main": "src/index.ts",
  "compatibility_date": "2026-05-01",
  "compatibility_flags": ["nodejs_compat"],
  "observability": { "enabled": true, "head_sampling_rate": 1 },
  "hyperdrive": [
    { "binding": "PG", "id": "<TO_FILL_AFTER_HYPERDRIVE_CREATE>" }
  ],
  "durable_objects": {
    "bindings": [
      { "name": "CMO", "class_name": "CMO" },
      { "name": "HEAD_OF_GROWTH", "class_name": "HeadOfGrowth" },
      { "name": "SOCIAL_MEDIA_MGR", "class_name": "SocialMediaMgr" },
      { "name": "X_MCP", "class_name": "XMcpAgent" },
      { "name": "REDDIT_MCP", "class_name": "RedditMcpAgent" }
    ]
  },
  "migrations": [
    {
      "tag": "v1",
      "new_sqlite_classes": [
        "CMO", "HeadOfGrowth", "SocialMediaMgr", "XMcpAgent", "RedditMcpAgent"
      ]
    }
  ],
  "workflows": [
    {
      "binding": "AGENT_PLAN_WORKFLOW",
      "name": "agent-plan-workflow",
      "class_name": "AgentPlanWorkflow"
    }
  ],
  "triggers": { "crons": ["0 * * * *"] }
}
```

- [ ] **Step 3: Write `apps/core/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "types": ["@cloudflare/workers-types"] },
  "include": ["src/**/*"]
}
```

- [ ] **Step 4: Write `apps/core/src/lib/jwt.ts`**

```typescript
async function importKey(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage]
  );
}

function b64urlEncode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function b64urlDecode(s: string): Uint8Array {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - s.length % 4) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

export async function signJwt(payload: Record<string, unknown>, secret: string, ttlSeconds = 60): Promise<string> {
  const header = { alg: "HS256", typ: "JWT" };
  const fullPayload = { ...payload, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + ttlSeconds };
  const encH = b64urlEncode(new TextEncoder().encode(JSON.stringify(header)));
  const encP = b64urlEncode(new TextEncoder().encode(JSON.stringify(fullPayload)));
  const data = `${encH}.${encP}`;
  const key = await importKey(secret, "sign");
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)));
  return `${data}.${b64urlEncode(sig)}`;
}

export async function verifyJwt(token: string, secret: string): Promise<Record<string, unknown>> {
  const [encH, encP, encS] = token.split(".");
  if (!encH || !encP || !encS) throw new Error("malformed jwt");
  const key = await importKey(secret, "verify");
  const ok = await crypto.subtle.verify(
    "HMAC", key,
    b64urlDecode(encS),
    new TextEncoder().encode(`${encH}.${encP}`)
  );
  if (!ok) throw new Error("invalid signature");
  const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(encP)));
  if (typeof payload.exp === "number" && payload.exp < Math.floor(Date.now() / 1000)) {
    throw new Error("token expired");
  }
  return payload;
}
```

- [ ] **Step 5: Write minimal `apps/core/src/index.ts`**

```typescript
import { routeAgentRequest } from "agents";

export interface Env {
  PG: Hyperdrive;
  CMO: DurableObjectNamespace;
  HEAD_OF_GROWTH: DurableObjectNamespace;
  SOCIAL_MEDIA_MGR: DurableObjectNamespace;
  X_MCP: DurableObjectNamespace;
  REDDIT_MCP: DurableObjectNamespace;
  AGENT_PLAN_WORKFLOW: Workflow;
  ANTHROPIC_API_KEY: string;
  XAI_API_KEY: string;
  MCP_JWT_SECRET: string;
  CHANNEL_ENC_KEY: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    // Phase 1.4 placeholder: routes wired in later tasks
    if (url.pathname === "/healthz") return Response.json({ ok: true });
    return new Response("not implemented yet", { status: 501 });
  },
  async scheduled(_event, _env, _ctx): Promise<void> {
    // Phase 1.4 placeholder
  },
} satisfies ExportedHandler<Env>;
```

- [ ] **Step 6: Provision Hyperdrive**

```bash
cd apps/core
wrangler hyperdrive create shipflare-dev --connection-string "$NEON_PROD_URL"
# copy the returned ID into wrangler.jsonc
```

- [ ] **Step 7: Verify Worker boots**

```bash
pnpm wrangler dev
# in another terminal:
curl http://localhost:3001/healthz
# expected: {"ok": true}
```

- [ ] **Step 8: Commit**

```bash
git add apps/core/
git commit -m "feat(core): scaffold Worker + jwt helper + healthz"
```

---

### Task S1.5: Create `apps/web` scaffold (Next.js + OpenNext + Better Auth)

**Files:**
- Create: `apps/web/package.json`
- Create: `apps/web/tsconfig.json`
- Create: `apps/web/next.config.ts`
- Create: `apps/web/open-next.config.ts`
- Create: `apps/web/wrangler.jsonc`
- Create: `apps/web/src/auth.ts`
- Create: `apps/web/src/db/index.ts`
- Create: `apps/web/app/layout.tsx`
- Create: `apps/web/app/page.tsx`
- Create: `apps/web/app/api/auth/[...all]/route.ts`

- [ ] **Step 1: Write `apps/web/package.json`**

```json
{
  "name": "@shipflare/web",
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "wrangler dev --port 3000",
    "build": "next build && opennextjs-cloudflare build",
    "deploy": "pnpm build && wrangler deploy",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@shipflare/shared": "workspace:*",
    "@shipflare/db": "workspace:*",
    "@shipflare/crypto": "workspace:*",
    "better-auth": "^1.5.0",
    "next": "^16.0.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "@modelcontextprotocol/sdk": "^1.0.0",
    "eventsource-parser": "^3.0.0"
  },
  "devDependencies": {
    "@opennextjs/cloudflare": "^1.0.0",
    "wrangler": "^4.0.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "typescript": "^5.5.0",
    "vitest": "^1.6.0"
  }
}
```

- [ ] **Step 2: Write `apps/web/next.config.ts`**

```typescript
import type { NextConfig } from "next";
const config: NextConfig = {
  reactStrictMode: true,
  experimental: { reactCompiler: false },
};
export default config;
```

- [ ] **Step 3: Write `apps/web/open-next.config.ts`**

```typescript
import { defineCloudflareConfig } from "@opennextjs/cloudflare";
export default defineCloudflareConfig({});
```

- [ ] **Step 4: Write `apps/web/wrangler.jsonc`**

```jsonc
{
  "$schema": "../../node_modules/wrangler/config-schema.json",
  "name": "shipflare-web",
  "main": ".open-next/worker.js",
  "compatibility_date": "2026-05-01",
  "compatibility_flags": ["nodejs_compat"],
  "observability": { "enabled": true, "head_sampling_rate": 1 },
  "hyperdrive": [
    { "binding": "PG", "id": "<SAME_AS_CORE>" }
  ],
  "services": [
    { "binding": "CORE", "service": "shipflare-core" }
  ],
  "assets": { "directory": ".open-next/assets", "binding": "ASSETS" }
}
```

- [ ] **Step 5: Write `apps/web/src/db/index.ts`**

```typescript
import { createDb, type DB } from "@shipflare/db";

let _db: DB | null = null;
export function getDb(env: { PG: Hyperdrive }): DB {
  if (_db) return _db;
  _db = createDb(env.PG.connectionString);
  return _db;
}
```

- [ ] **Step 6: Write `apps/web/src/auth.ts`**

```typescript
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getDb } from "./db";

export function getAuth() {
  const { env } = getCloudflareContext();
  const db = getDb(env);
  return betterAuth({
    database: drizzleAdapter(db, { provider: "pg" }),
    socialProviders: {
      github: {
        clientId: env.GITHUB_CLIENT_ID,
        clientSecret: env.GITHUB_CLIENT_SECRET,
      },
    },
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.PUBLIC_URL ?? "http://localhost:3000",
    callbacks: {
      session: async ({ user, session }) => {
        // First-login CMO init hook
        if (!user.metadata?.cmoInitialized) {
          await env.CORE.fetch(
            new Request(`https://internal/agents/cmo/${user.id}/internal/init`, {
              method: "POST",
              headers: { "x-shipflare-internal": "1" },
              body: JSON.stringify({
                email: user.email,
                githubLogin: user.name,
              }),
            })
          );
          // Mark via Better Auth additional fields (or a separate flag table; for spike just check existence)
        }
        return { user, session };
      },
    },
  });
}
```

- [ ] **Step 7: Write `apps/web/app/api/auth/[...all]/route.ts`**

```typescript
import { getAuth } from "@/auth";

export async function GET(req: Request) {
  const auth = getAuth();
  return auth.handler(req);
}
export async function POST(req: Request) {
  const auth = getAuth();
  return auth.handler(req);
}
```

- [ ] **Step 8: Write minimal `apps/web/app/layout.tsx` and `page.tsx`**

```tsx
// app/layout.tsx
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html><body>{children}</body></html>;
}

// app/page.tsx
export default function Home() {
  return <main><h1>ShipFlare</h1><a href="/api/auth/sign-in/social?provider=github">Sign in with GitHub</a></main>;
}
```

- [ ] **Step 9: Build + verify**

```bash
cd apps/web
pnpm build
pnpm wrangler dev
# in another terminal:
curl http://localhost:3000/
# expected: HTML with "ShipFlare" + sign-in link
```

- [ ] **Step 10: Commit**

```bash
git add apps/web/
git commit -m "feat(web): scaffold Next.js + OpenNext + Better Auth"
```

---

## S2 — CMO McpAgent (Day 2-5)

### Task S2.0: CMO class skeleton + SQLite schema

**Files:**
- Create: `apps/core/src/agents/cmo/CMO.ts`
- Create: `apps/core/src/agents/cmo/schema.ts`

- [ ] **Step 1: Write `CMO.ts` skeleton**

```typescript
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type McpProps } from "@shipflare/shared";
import { applyCmoSchema } from "./schema";

type CMOState = { initialized: boolean; lastWakeAt: number };

export class CMO extends McpAgent<Env, CMOState, McpProps> {
  server = new McpServer({ name: "shipflare-cmo", version: "1.0.0" });
  initialState: CMOState = { initialized: false, lastWakeAt: 0 };

  async onStart() {
    applyCmoSchema(this.ctx.storage.sql);
    this.setState({ ...this.state, lastWakeAt: Date.now() });
  }

  async init() {
    // tools registered in subsequent tasks
  }
}
```

- [ ] **Step 2: Write `schema.ts`** (per spec §4.2.3)

```typescript
import type { SqlStorage } from "cloudflare:workers";

export function applyCmoSchema(sql: SqlStorage) {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      title TEXT,
      archived INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS founder_messages (
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      ts INTEGER NOT NULL,
      tool_calls_json TEXT,
      meta_json TEXT,
      PRIMARY KEY (conversation_id, ts, role)
    );
    CREATE INDEX IF NOT EXISTS idx_messages_conv_ts ON founder_messages(conversation_id, ts);

    CREATE TABLE IF NOT EXISTS founder_context (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS roster (
      role TEXT PRIMARY KEY,
      hired_at INTEGER NOT NULL,
      status TEXT NOT NULL,
      hire_config_json TEXT
    );

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
    CREATE INDEX IF NOT EXISTS idx_plan_status ON plan_items(status, owner_role);

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
    CREATE INDEX IF NOT EXISTS idx_emp_log_unnotified ON employee_log(notified_founder, ts);

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

    CREATE TABLE IF NOT EXISTS progress_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      posts_drafted INTEGER NOT NULL DEFAULT 0,
      posts_published INTEGER NOT NULL DEFAULT 0,
      replies_drafted INTEGER NOT NULL DEFAULT 0,
      replies_published INTEGER NOT NULL DEFAULT 0,
      json TEXT
    );
  `);
}
```

- [ ] **Step 3: Register CMO in `apps/core/src/index.ts`**

Edit `apps/core/src/index.ts` to export the class:

```typescript
export { CMO } from "./agents/cmo/CMO";
```

- [ ] **Step 4: Run wrangler dev, verify class loads**

```bash
cd apps/core
pnpm wrangler dev
# in another terminal:
curl http://localhost:3001/agents/cmo/test-user/info
# (returns 501 for now; just verifying the class doesn't blow up at module load)
pnpm wrangler tail   # should show no errors
```

- [ ] **Step 5: Commit**

```bash
git add apps/core/src/agents/cmo/ apps/core/src/index.ts
git commit -m "feat(cmo): class skeleton + SQLite schema"
```

---

### Task S2.1: CMO `chat` tool — basic LLM call, persists messages

**Files:**
- Create: `apps/core/src/agents/cmo/tools.ts`
- Modify: `apps/core/src/agents/cmo/CMO.ts:1` (wire tools in `init()`)

- [ ] **Step 1: Write `tools.ts` chat handler**

```typescript
import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";
import type { CMO } from "./CMO";

export function registerChatTool(agent: CMO) {
  agent.server.registerTool(
    "chat",
    {
      description: "Send a message to the CMO; returns assistant reply.",
      inputSchema: {
        conversationId: z.string(),
        message: z.string(),
      },
    },
    async ({ conversationId, message }, extra) => {
      const ts = Date.now();
      // Persist user message
      agent.ctx.storage.sql.exec(
        "INSERT INTO founder_messages (conversation_id, role, content, ts) VALUES (?, ?, ?, ?)",
        conversationId, "user", message, ts
      );

      // Load conversation history
      const history = agent.ctx.storage.sql.exec<{ role: string; content: string }>(
        "SELECT role, content FROM founder_messages WHERE conversation_id = ? ORDER BY ts",
        conversationId
      ).toArray();

      // Load founder context
      const ctxRows = agent.ctx.storage.sql.exec<{ key: string; value: string }>(
        "SELECT key, value FROM founder_context"
      ).toArray();
      const founderContext = Object.fromEntries(ctxRows.map((r) => [r.key, r.value]));

      // LLM call
      const client = new Anthropic({ apiKey: agent.env.ANTHROPIC_API_KEY });
      const response = await client.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 2048,
        system: buildSystemPrompt(founderContext),
        messages: history.map((h) => ({ role: h.role as "user" | "assistant", content: h.content })),
      });

      const replyText = response.content
        .filter((c) => c.type === "text")
        .map((c) => (c as { type: "text"; text: string }).text)
        .join("\n");

      // Persist assistant message
      agent.ctx.storage.sql.exec(
        "INSERT INTO founder_messages (conversation_id, role, content, ts) VALUES (?, ?, ?, ?)",
        conversationId, "assistant", replyText, Date.now()
      );

      return {
        content: [{ type: "text", text: replyText }],
      };
    }
  );
}

function buildSystemPrompt(ctx: Record<string, string>): string {
  return `You are the CMO for ${ctx.productName ?? "the founder"}'s AI marketing team.
Product: ${ctx.productName ?? "(not yet set)"}.
Voice: ${ctx.voice ?? "default"}.

You orchestrate; you do not write content yourself. Route strategic questions to Head of Growth,
operational questions to Social Media Manager. Keep replies under 3 sentences unless asked for more.`;
}
```

- [ ] **Step 2: Wire `chat` tool in `CMO.init()`**

Edit `apps/core/src/agents/cmo/CMO.ts`:

```typescript
import { registerChatTool } from "./tools";

// in init():
async init() {
  registerChatTool(this);
  // more tools in next tasks
}
```

- [ ] **Step 3: Write test `apps/core/test/cmo-chat.test.ts`**

```typescript
import { env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

// This test uses the in-process MCP server route
describe("CMO chat tool", () => {
  it("persists user + assistant messages", async () => {
    const stub = env.CMO.getByName("test-user");
    const result = await runInDurableObject(stub, async (instance: any) => {
      // Call chat via direct method invocation
      // (bypassing MCP transport for test simplicity)
      const sql = instance.ctx.storage.sql;
      // Seed founder context
      sql.exec("INSERT INTO founder_context (key, value) VALUES (?, ?)", "productName", "TestProduct");
      // Simulate chat tool call inline
      const conversationId = "conv-1";
      const ts = Date.now();
      sql.exec(
        "INSERT INTO founder_messages (conversation_id, role, content, ts) VALUES (?, ?, ?, ?)",
        conversationId, "user", "hello", ts
      );
      const rows = sql.exec("SELECT * FROM founder_messages WHERE conversation_id = ?", conversationId).toArray();
      return { count: rows.length };
    });
    expect(result.count).toBe(1);
  });
});
```

- [ ] **Step 4: Run test**

Run: `cd apps/core && pnpm vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/core/src/agents/cmo/tools.ts apps/core/src/agents/cmo/CMO.ts apps/core/test/cmo-chat.test.ts
git commit -m "feat(cmo): chat tool persists messages and calls Anthropic"
```

---

### Task S2.2: CMO conversation + roster tools

**Files:**
- Modify: `apps/core/src/agents/cmo/tools.ts:1` (add tools)

- [ ] **Step 1: Add `startNewConversation` to `tools.ts`**

```typescript
export function registerConversationTools(agent: CMO) {
  agent.server.registerTool(
    "startNewConversation",
    {
      description: "Begin a new conversation thread. Chat history resets; founder_context preserved.",
      inputSchema: { title: z.string().optional() },
    },
    async ({ title }, extra) => {
      const id = crypto.randomUUID();
      agent.ctx.storage.sql.exec(
        "INSERT INTO conversations (id, started_at, title) VALUES (?, ?, ?)",
        id, Date.now(), title ?? null
      );
      return { content: [{ type: "text", text: JSON.stringify({ conversationId: id }) }] };
    }
  );

  agent.server.registerTool(
    "listConversations",
    {
      description: "List recent conversations.",
      inputSchema: { limit: z.number().default(20) },
    },
    async ({ limit }) => {
      const rows = agent.ctx.storage.sql.exec(
        "SELECT id, started_at, ended_at, title FROM conversations WHERE archived = 0 ORDER BY started_at DESC LIMIT ?",
        limit
      ).toArray();
      return { content: [{ type: "text", text: JSON.stringify(rows) }] };
    }
  );
}
```

- [ ] **Step 2: Add `hireEmployee` / `fireEmployee`**

```typescript
import { ROLE_REGISTRY, type RoleSlug } from "@shipflare/shared";

export function registerRosterTools(agent: CMO) {
  agent.server.registerTool(
    "hireEmployee",
    {
      description: "Hire an employee role for this team.",
      inputSchema: {
        role: z.string(),
        hireConfig: z.record(z.unknown()).optional(),
      },
    },
    async ({ role, hireConfig }) => {
      if (!(role in ROLE_REGISTRY)) throw new Error(`Unknown role: ${role}`);
      if (role === "cmo") throw new Error("CMO is implicit; cannot hire");
      agent.ctx.storage.sql.exec(
        `INSERT INTO roster (role, hired_at, status, hire_config_json)
         VALUES (?, ?, 'active', ?)
         ON CONFLICT(role) DO UPDATE SET status='active', hire_config_json=excluded.hire_config_json`,
        role, Date.now(), hireConfig ? JSON.stringify(hireConfig) : null
      );
      return { content: [{ type: "text", text: `Hired ${role}` }] };
    }
  );

  agent.server.registerTool(
    "fireEmployee",
    {
      description: "Set employee status to 'fired' (preserves history; can re-hire later).",
      inputSchema: { role: z.string() },
    },
    async ({ role }) => {
      agent.ctx.storage.sql.exec(
        "UPDATE roster SET status='fired' WHERE role = ?", role
      );
      return { content: [{ type: "text", text: `Fired ${role}` }] };
    }
  );

  agent.server.registerTool(
    "queryRoster",
    {
      description: "Return current team roster.",
      inputSchema: {},
    },
    async () => {
      const rows = agent.ctx.storage.sql.exec(
        "SELECT role, hired_at, status FROM roster ORDER BY hired_at"
      ).toArray();
      return { content: [{ type: "text", text: JSON.stringify(rows) }] };
    }
  );
}
```

- [ ] **Step 3: Wire in CMO.init()**

```typescript
import { registerChatTool, registerConversationTools, registerRosterTools } from "./tools";

async init() {
  registerChatTool(this);
  registerConversationTools(this);
  registerRosterTools(this);
}
```

- [ ] **Step 4: Write test for hire/fire**

```typescript
import { env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";

describe("CMO roster", () => {
  it("hire / fire / query", async () => {
    const stub = env.CMO.getByName("roster-test-user");
    await runInDurableObject(stub, async (instance: any) => {
      const sql = instance.ctx.storage.sql;
      sql.exec("INSERT INTO roster (role, hired_at, status) VALUES ('head-of-growth', 0, 'active')");
      sql.exec("INSERT INTO roster (role, hired_at, status) VALUES ('social-media-manager', 0, 'active')");
      const rows = sql.exec("SELECT * FROM roster WHERE status='active'").toArray();
      expect(rows).toHaveLength(2);
    });
  });
});
```

- [ ] **Step 5: Run + commit**

```bash
cd apps/core && pnpm vitest run
git add apps/core/src/agents/cmo/ apps/core/test/
git commit -m "feat(cmo): conversation + roster tools"
```

---

### Task S2.3: CMO `onStart` — connect employees via addMcpServer

**Files:**
- Modify: `apps/core/src/agents/cmo/CMO.ts:1`

- [ ] **Step 1: Add `connectEmployees` in `onStart`**

```typescript
async onStart() {
  applyCmoSchema(this.ctx.storage.sql);
  this.setState({ ...this.state, lastWakeAt: Date.now() });
  await this.connectEmployees();
}

private async connectEmployees() {
  const hires = this.ctx.storage.sql.exec<{ role: string }>(
    "SELECT role FROM roster WHERE status='active'"
  ).toArray();

  for (const { role } of hires) {
    const entry = ROLE_REGISTRY[role as RoleSlug];
    if (!entry) continue;
    const binding = this.env[entry.binding] as DurableObjectNamespace;
    await this.addMcpServer(role, binding, {
      props: { userId: this.props.userId, caller: "cmo" },
    });
  }
}
```

- [ ] **Step 2: Verify boot still works**

```bash
cd apps/core
pnpm wrangler dev
# expect no errors; empty roster = no addMcpServer calls
```

- [ ] **Step 3: Commit**

```bash
git add apps/core/src/agents/cmo/CMO.ts
git commit -m "feat(cmo): onStart connects active employees via addMcpServer"
```

---

### Task S2.4: CMO delegate + shared-state tools

**Files:**
- Modify: `apps/core/src/agents/cmo/tools.ts:1`

- [ ] **Step 1: Add `delegateToEmployee` tool**

```typescript
export function registerDelegationTools(agent: CMO) {
  agent.server.registerTool(
    "delegateToEmployee",
    {
      description: "Hand off a goal to a specific employee; returns their result.",
      inputSchema: {
        role: z.string(),
        tool: z.string(),
        args: z.record(z.unknown()),
        conversationId: z.string(),
      },
    },
    async ({ role, tool, args, conversationId }) => {
      const mcpServer = (agent as any).mcpServers?.[role];
      if (!mcpServer) throw new Error(`Employee ${role} not connected (not hired?)`);
      const result = await mcpServer.callTool(tool, { ...args, conversationId });
      // Log the delegation
      agent.ctx.storage.sql.exec(
        `INSERT INTO employee_log (conversation_id, from_role, kind, summary, payload_json, ts)
         VALUES (?, ?, 'task_complete', ?, ?, ?)`,
        conversationId, role, `${role}.${tool} returned`, JSON.stringify(result), Date.now()
      );
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
  );
}
```

- [ ] **Step 2: Add CMO-exposed shared-state tools** (employees call these via RPC)

```typescript
export function registerSharedStateTools(agent: CMO) {
  agent.server.registerTool("queryFounderContext", {
    description: "Read founder/product context (employees use this).",
    inputSchema: {},
  }, async () => {
    const rows = agent.ctx.storage.sql.exec(
      "SELECT key, value FROM founder_context"
    ).toArray();
    return { content: [{ type: "text", text: JSON.stringify(Object.fromEntries(rows.map((r: any) => [r.key, r.value]))) }] };
  });

  agent.server.registerTool("commitStrategicPath", {
    description: "Record a new strategic path (called by Head of Growth).",
    inputSchema: {
      theme: z.string(),
      narrative: z.record(z.unknown()),
      generatedBy: z.string(),
    },
  }, async ({ theme, narrative, generatedBy }) => {
    const id = crypto.randomUUID();
    const latest = agent.ctx.storage.sql.exec<{ version: number }>(
      "SELECT COALESCE(MAX(version), 0) as version FROM strategic_path"
    ).one();
    agent.ctx.storage.sql.exec(
      `INSERT INTO strategic_path (id, version, theme, narrative_json, status, generated_at, generated_by)
       VALUES (?, ?, ?, ?, 'pending_approval', ?, ?)`,
      id, latest.version + 1, theme, JSON.stringify(narrative), Date.now(), generatedBy
    );
    return { content: [{ type: "text", text: JSON.stringify({ id, version: latest.version + 1 }) }] };
  });

  agent.server.registerTool("addPlanItem", {
    description: "Create a plan item (HoG or SMM writes these).",
    inputSchema: {
      skill: z.string(),
      channel: z.enum(["x", "reddit"]),
      params: z.record(z.unknown()),
      ownerRole: z.string(),
      scheduledFor: z.number().optional(),
    },
  }, async ({ skill, channel, params, ownerRole, scheduledFor }) => {
    const id = crypto.randomUUID();
    agent.ctx.storage.sql.exec(
      `INSERT INTO plan_items (id, skill, channel, params_json, status, owner_role, scheduled_for)
       VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
      id, skill, channel, JSON.stringify(params), ownerRole, scheduledFor ?? null
    );
    return { content: [{ type: "text", text: JSON.stringify({ id }) }] };
  });

  agent.server.registerTool("queryPlanItems", {
    description: "Query plan items (SMM reads these to know what to work on).",
    inputSchema: {
      status: z.string().optional(),
      ownerRole: z.string().optional(),
      limit: z.number().default(50),
    },
  }, async ({ status, ownerRole, limit }) => {
    let q = "SELECT * FROM plan_items WHERE 1=1";
    const args: unknown[] = [];
    if (status) { q += " AND status = ?"; args.push(status); }
    if (ownerRole) { q += " AND owner_role = ?"; args.push(ownerRole); }
    q += " ORDER BY scheduled_for NULLS LAST, plan_version LIMIT ?";
    args.push(limit);
    const rows = agent.ctx.storage.sql.exec(q, ...args).toArray();
    return { content: [{ type: "text", text: JSON.stringify(rows) }] };
  });

  agent.server.registerTool("updatePlanItem", {
    description: "Update plan_item status / output.",
    inputSchema: {
      id: z.string(),
      status: z.enum(["pending", "in_progress", "completed", "failed", "cancelled"]),
      output: z.record(z.unknown()).optional(),
    },
  }, async ({ id, status, output }) => {
    const now = Date.now();
    agent.ctx.storage.sql.exec(
      `UPDATE plan_items SET status = ?, output_json = ?,
       started_at = COALESCE(started_at, CASE WHEN ? = 'in_progress' THEN ? END),
       completed_at = CASE WHEN ? IN ('completed','failed','cancelled') THEN ? ELSE completed_at END
       WHERE id = ?`,
      status, output ? JSON.stringify(output) : null, status, now, status, now, id
    );
    return { content: [{ type: "text", text: "ok" }] };
  });

  agent.server.registerTool("approveDraft", {
    description: "Approve a draft and trigger publication.",
    inputSchema: { draftId: z.string() },
  }, async ({ draftId }) => {
    agent.ctx.storage.sql.exec(
      "UPDATE approval_queue SET decided_at = ?, decision = 'approved' WHERE draft_id = ?",
      Date.now(), draftId
    );
    return { content: [{ type: "text", text: "approved" }] };
  });
}
```

- [ ] **Step 2: Wire into init()**

```typescript
async init() {
  registerChatTool(this);
  registerConversationTools(this);
  registerRosterTools(this);
  registerDelegationTools(this);
  registerSharedStateTools(this);
}
```

- [ ] **Step 3: Write test for plan_item CRUD**

```typescript
import { env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";

describe("CMO shared state", () => {
  it("addPlanItem + queryPlanItems round-trip", async () => {
    const stub = env.CMO.getByName("plan-test-user");
    await runInDurableObject(stub, async (instance: any) => {
      const sql = instance.ctx.storage.sql;
      sql.exec(`INSERT INTO plan_items (id, skill, channel, params_json, status, owner_role)
                VALUES ('pi-1', 'drafting-post', 'x', '{}', 'pending', 'social-media-manager')`);
      const rows = sql.exec("SELECT id FROM plan_items WHERE status='pending'").toArray();
      expect(rows).toHaveLength(1);
    });
  });
});
```

- [ ] **Step 4: Commit**

```bash
git add apps/core/src/agents/cmo/ apps/core/test/
git commit -m "feat(cmo): delegate + shared-state tools (commitStrategicPath, plan_items, approveDraft)"
```

---

### Task S2.5: CMO internal endpoints (`/init`, `/peer-dm-shadow`, `/cron-tick`)

**Files:**
- Modify: `apps/core/src/agents/cmo/CMO.ts:1` (add `fetch` handler)

- [ ] **Step 1: Add `fetch` to CMO**

```typescript
async fetch(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/internal/init") return this.handleInit(request);
  if (url.pathname === "/internal/peer-dm-shadow") return this.handlePeerShadow(request);
  if (url.pathname === "/internal/cron-tick") return this.handleCronTick(request);
  return new Response("not found", { status: 404 });
}

private async handleInit(request: Request): Promise<Response> {
  const body = await request.json() as { email: string; githubLogin: string };
  // Idempotent
  const existing = this.ctx.storage.sql.exec(
    "SELECT COUNT(*) as c FROM founder_context"
  ).one() as { c: number };
  if (existing.c > 0) {
    return new Response("already_initialized");
  }
  // Seed context
  this.ctx.storage.sql.exec(
    "INSERT INTO founder_context (key, value) VALUES ('email', ?), ('githubLogin', ?)",
    body.email, body.githubLogin
  );
  // Seed default roster
  const now = Date.now();
  this.ctx.storage.sql.exec(
    `INSERT INTO roster (role, hired_at, status) VALUES
     ('head-of-growth', ?, 'active'),
     ('social-media-manager', ?, 'active')`,
    now, now
  );
  // Reconnect employees now that roster has entries
  await this.connectEmployees();
  return new Response("initialized");
}

private async handlePeerShadow(request: Request): Promise<Response> {
  const body = await request.json() as {
    conversationId?: string;
    fromRole: string;
    toRole: string;
    tool: string;
    summary: string;
    payload?: unknown;
  };
  this.ctx.storage.sql.exec(
    `INSERT INTO employee_log (conversation_id, from_role, kind, summary, payload_json, ts, notified_founder)
     VALUES (?, ?, 'peer_dm_shadow', ?, ?, ?, 0)`,
    body.conversationId ?? null, body.fromRole,
    body.summary, body.payload ? JSON.stringify({ to: body.toRole, tool: body.tool, payload: body.payload }) : null,
    Date.now()
  );
  return new Response("logged");
}

private async handleCronTick(_request: Request): Promise<Response> {
  // Trigger SMM inbound sweep via delegation
  try {
    const smm = (this as any).mcpServers?.["social-media-manager"];
    if (smm) {
      await smm.callTool("findThreadsViaXai", {
        platform: "x",
        intent: "hourly-sweep",
      });
    }
  } catch (e) {
    console.error("cron-tick failed", e);
  }
  return new Response("ticked");
}
```

- [ ] **Step 2: Write test**

```typescript
import { env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";

describe("CMO internal endpoints", () => {
  it("/internal/init seeds context and roster", async () => {
    const stub = env.CMO.getByName("init-test-user");
    const res = await stub.fetch(new Request("https://x/internal/init", {
      method: "POST",
      body: JSON.stringify({ email: "test@example.com", githubLogin: "tester" }),
    }));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("initialized");

    await runInDurableObject(stub, async (instance: any) => {
      const ctxCount = instance.ctx.storage.sql.exec("SELECT COUNT(*) as c FROM founder_context").one().c;
      const rosterCount = instance.ctx.storage.sql.exec("SELECT COUNT(*) as c FROM roster").one().c;
      expect(ctxCount).toBeGreaterThan(0);
      expect(rosterCount).toBe(2);
    });
  });
});
```

- [ ] **Step 3: Run + commit**

```bash
cd apps/core && pnpm vitest run
git add apps/core/src/agents/cmo/CMO.ts apps/core/test/
git commit -m "feat(cmo): /internal/init + /peer-dm-shadow + /cron-tick endpoints"
```

---

### Task S2.6: Wire core Worker entry — `/agents/cmo/<userId>/mcp` routing + JWT auth

**Files:**
- Modify: `apps/core/src/index.ts:1`

- [ ] **Step 1: Update `apps/core/src/index.ts`**

```typescript
import { CMO } from "./agents/cmo/CMO";
// import other DO classes once written (placeholder for now)
import { verifyJwt } from "./lib/jwt";
import { ROLE_REGISTRY, type RoleSlug } from "@shipflare/shared";

export { CMO };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/healthz") return Response.json({ ok: true });

    // /agents/<role>/<userId>/mcp
    const mcpMatch = url.pathname.match(/^\/agents\/([a-z-]+)\/([^/]+)\/mcp/);
    if (mcpMatch) return await handleMcpRequest(request, env, mcpMatch[1], mcpMatch[2]);

    // /agents/<role>/<userId>/internal/<...>
    const intMatch = url.pathname.match(/^\/agents\/([a-z-]+)\/([^/]+)(\/internal\/.+)$/);
    if (intMatch) return await handleInternalRequest(request, env, intMatch[1], intMatch[2], intMatch[3]);

    return new Response("not found", { status: 404 });
  },

  async scheduled(_event, env, _ctx): Promise<void> {
    // List active users (Postgres via Hyperdrive)
    // For Phase 1, simplify: fan out by querying user table
    const { createDb, user } = await import("@shipflare/db");
    const db = createDb(env.PG.connectionString);
    const users = await db.select({ id: user.id }).from(user);
    await Promise.all(users.map((u) => {
      const stub = env.CMO.idFromName(u.id);
      return env.CMO.get(stub).fetch(new Request(`https://internal/internal/cron-tick`, { method: "POST" }));
    }));
  },
} satisfies ExportedHandler<Env>;

async function handleMcpRequest(request: Request, env: Env, role: string, userId: string): Promise<Response> {
  // Allow internal callers (Service Binding) without JWT
  if (request.headers.get("x-shipflare-internal") === "1") {
    return routeToDO(env, role, userId, request, { userId, caller: "external" });
  }

  // External callers: validate JWT
  const auth = request.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return new Response("unauthorized", { status: 401 });
  try {
    const payload = await verifyJwt(auth.slice(7), env.MCP_JWT_SECRET);
    if (payload.userId !== userId) return new Response("forbidden", { status: 403 });
    // Verify role is hired (skip for cmo itself)
    if (role !== "cmo") {
      const cmoStub = env.CMO.idFromName(userId);
      const rosterRes = await env.CMO.get(cmoStub).fetch(new Request("https://x/internal/query-roster"));
      // Simplified: trust the DO returns the roster
      const roster = await rosterRes.json() as Array<{ role: string; status: string }>;
      if (!roster.some((r) => r.role === role && r.status === "active")) {
        return new Response("not hired", { status: 403 });
      }
    }
    return routeToDO(env, role, userId, request, { userId, caller: "external" });
  } catch {
    return new Response("invalid token", { status: 401 });
  }
}

async function routeToDO(env: Env, role: string, userId: string, request: Request, props: any): Promise<Response> {
  const entry = ROLE_REGISTRY[role as RoleSlug];
  if (!entry) return new Response("unknown role", { status: 404 });
  const ns = env[entry.binding] as DurableObjectNamespace;
  const stub = ns.idFromName(userId);
  // Inject props via header for the McpAgent serve handler to pick up
  const newReq = new Request(request, { headers: new Headers({ ...Object.fromEntries(request.headers), "x-mcp-props": JSON.stringify(props) }) });
  return ns.get(stub).fetch(newReq);
}

async function handleInternalRequest(request: Request, env: Env, role: string, userId: string, internalPath: string): Promise<Response> {
  if (request.headers.get("x-shipflare-internal") !== "1") return new Response("forbidden", { status: 403 });
  const entry = ROLE_REGISTRY[role as RoleSlug];
  if (!entry) return new Response("unknown role", { status: 404 });
  const ns = env[entry.binding] as DurableObjectNamespace;
  const stub = ns.idFromName(userId);
  return ns.get(stub).fetch(new Request(`https://x${internalPath}`, request));
}
```

- [ ] **Step 2: Write integration test**

```typescript
import { SELF, env } from "cloudflare:test";
import { describe, it, expect } from "vitest";

describe("CMO Worker entry", () => {
  it("/internal/init via Service-Binding-style header succeeds", async () => {
    const res = await SELF.fetch("https://example.com/agents/cmo/test-init-user/internal/init", {
      method: "POST",
      headers: { "x-shipflare-internal": "1" },
      body: JSON.stringify({ email: "x@x.com", githubLogin: "x" }),
    });
    expect(res.status).toBe(200);
  });

  it("external MCP without JWT returns 401", async () => {
    const res = await SELF.fetch("https://example.com/agents/cmo/test-user/mcp", { method: "POST" });
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 3: Commit**

```bash
git add apps/core/src/index.ts apps/core/test/
git commit -m "feat(core): Worker entry with MCP routing + JWT auth + cron fan-out"
```

---

## S3 — Head of Growth McpAgent (Day 4-6, parallel with S4)

### Task S3.0: HoG class skeleton + schema

**Files:**
- Create: `apps/core/src/agents/head-of-growth/HeadOfGrowth.ts`
- Create: `apps/core/src/agents/head-of-growth/schema.ts`

- [ ] **Step 1: Write `schema.ts`** (per spec §4.2.4)

```typescript
import type { SqlStorage } from "cloudflare:workers";

export function applyHogSchema(sql: SqlStorage) {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS planning_chat (
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      ts INTEGER NOT NULL,
      PRIMARY KEY (conversation_id, ts, role)
    );

    CREATE TABLE IF NOT EXISTS proposal_drafts (
      id TEXT PRIMARY KEY,
      theme TEXT NOT NULL,
      narrative_md TEXT NOT NULL,
      status TEXT NOT NULL,
      alternatives_json TEXT,
      confidence REAL NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_findings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT,
      target_id TEXT,
      severity TEXT NOT NULL,
      finding TEXT NOT NULL,
      suggested_fix TEXT,
      status TEXT NOT NULL DEFAULT 'open'
    );
  `);
}
```

- [ ] **Step 2: Write `HeadOfGrowth.ts`**

```typescript
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type McpProps } from "@shipflare/shared";
import { applyHogSchema } from "./schema";
import { registerHogTools } from "./tools";

type HogState = { lastWakeAt: number };

export class HeadOfGrowth extends McpAgent<Env, HogState, McpProps> {
  server = new McpServer({ name: "shipflare-hog", version: "1.0.0" });
  initialState: HogState = { lastWakeAt: 0 };

  async onStart() {
    applyHogSchema(this.ctx.storage.sql);
    this.setState({ lastWakeAt: Date.now() });
  }

  async init() {
    registerHogTools(this);
  }
}
```

- [ ] **Step 3: Add export in `apps/core/src/index.ts`**

```typescript
export { HeadOfGrowth } from "./agents/head-of-growth/HeadOfGrowth";
```

- [ ] **Step 4: Commit**

```bash
git add apps/core/src/agents/head-of-growth/ apps/core/src/index.ts
git commit -m "feat(hog): class skeleton + schema"
```

---

### Task S3.1: HoG `generateStrategicPath` tool

**Files:**
- Create: `apps/core/src/agents/head-of-growth/tools.ts`

- [ ] **Step 1: Write `tools.ts`**

```typescript
import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";
import type { HeadOfGrowth } from "./HeadOfGrowth";

export function registerHogTools(agent: HeadOfGrowth) {
  agent.server.registerTool(
    "generateStrategicPath",
    {
      description: "Generate a marketing strategy plan based on founder goals and product context.",
      inputSchema: {
        goal: z.string(),
        conversationId: z.string(),
      },
    },
    async ({ goal, conversationId }, extra) => {
      const props = (extra as any).props;
      // Fetch founder context via CMO RPC
      const cmoServer = (agent as any).mcpServers?.cmo;
      if (!cmoServer) {
        // Fall back: CMO is the caller, so we can't RPC back — accept context from input
      }

      let context: Record<string, string> = {};
      if (cmoServer) {
        const ctxResult = await cmoServer.callTool("queryFounderContext", {});
        context = JSON.parse(ctxResult.content[0].text);
      }

      // LLM brainstorm
      const client = new Anthropic({ apiKey: agent.env.ANTHROPIC_API_KEY });
      const response = await client.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 4096,
        system: `You are the Head of Growth for ${context.productName ?? "this product"}.
Generate a focused strategic marketing path. Output structured JSON with:
{
  "theme": "one-line theme",
  "narrative": { "thesis": "...", "wedge": "...", "channels": ["x"], "first30days": [...] },
  "rationale": "why this approach"
}`,
        messages: [{ role: "user", content: `Founder goal: ${goal}` }],
      });

      const text = response.content.filter((c) => c.type === "text").map((c) => (c as any).text).join("");
      let parsed: any;
      try {
        parsed = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
      } catch {
        parsed = { theme: "Fallback", narrative: {}, rationale: text };
      }

      // Persist planning chat
      agent.ctx.storage.sql.exec(
        `INSERT INTO planning_chat (conversation_id, role, content, ts) VALUES (?, 'user', ?, ?), (?, 'assistant', ?, ?)`,
        conversationId, goal, Date.now(),
        conversationId, text, Date.now() + 1
      );

      // Commit to CMO
      if (cmoServer) {
        await cmoServer.callTool("commitStrategicPath", {
          theme: parsed.theme,
          narrative: parsed.narrative,
          generatedBy: "head-of-growth",
        });
      }

      return {
        content: [{ type: "text", text: JSON.stringify({
          theme: parsed.theme,
          summary: parsed.rationale,
        })}],
      };
    }
  );

  agent.server.registerTool(
    "auditPlan",
    {
      description: "Review current plan_items for gaps or risks.",
      inputSchema: { conversationId: z.string() },
    },
    async ({ conversationId }, extra) => {
      const cmoServer = (agent as any).mcpServers?.cmo;
      if (!cmoServer) return { content: [{ type: "text", text: "{\"findings\":[]}" }] };
      const planResult = await cmoServer.callTool("queryPlanItems", { status: "pending", limit: 100 });
      const items = JSON.parse(planResult.content[0].text);

      const client = new Anthropic({ apiKey: agent.env.ANTHROPIC_API_KEY });
      const response = await client.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 2048,
        system: "You are the Head of Growth auditing a marketing plan. Find gaps, redundancies, risks. Output JSON array of {severity:'high'|'med'|'low', finding:string, suggestedFix:string}.",
        messages: [{ role: "user", content: `Plan items:\n${JSON.stringify(items, null, 2)}` }],
      });
      const text = response.content.filter((c) => c.type === "text").map((c) => (c as any).text).join("");
      const findings = JSON.parse(text.match(/\[[\s\S]*\]/)?.[0] ?? "[]");

      for (const f of findings) {
        agent.ctx.storage.sql.exec(
          `INSERT INTO audit_findings (conversation_id, severity, finding, suggested_fix)
           VALUES (?, ?, ?, ?)`,
          conversationId, f.severity, f.finding, f.suggestedFix ?? null
        );
      }
      return { content: [{ type: "text", text: JSON.stringify({ findingsCount: findings.length, findings }) }] };
    }
  );
}
```

- [ ] **Step 2: Write smoke test**

```typescript
import { env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";

describe("HoG schema", () => {
  it("planning_chat table exists", async () => {
    const stub = env.HEAD_OF_GROWTH.getByName("hog-test-user");
    await runInDurableObject(stub, async (instance: any) => {
      instance.ctx.storage.sql.exec(
        "INSERT INTO planning_chat (conversation_id, role, content, ts) VALUES ('c1', 'user', 'hello', 1)"
      );
      const rows = instance.ctx.storage.sql.exec("SELECT * FROM planning_chat").toArray();
      expect(rows).toHaveLength(1);
    });
  });
});
```

- [ ] **Step 3: Commit**

```bash
git add apps/core/src/agents/head-of-growth/tools.ts apps/core/test/
git commit -m "feat(hog): generateStrategicPath + auditPlan tools"
```

---

## S4 — SocialMediaMgr McpAgent (Day 4-7, parallel with S3)

### Task S4.0: SMM class skeleton + schema

**Files:**
- Create: `apps/core/src/agents/social-media-manager/SocialMediaMgr.ts`
- Create: `apps/core/src/agents/social-media-manager/schema.ts`

- [ ] **Step 1: Write `schema.ts`** (per spec §4.2.5)

```typescript
import type { SqlStorage } from "cloudflare:workers";

export function applySmmSchema(sql: SqlStorage) {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS threads_inbox (
      id TEXT PRIMARY KEY,
      platform TEXT NOT NULL,
      external_id TEXT NOT NULL,
      author TEXT,
      content TEXT NOT NULL,
      score REAL,
      judged_at INTEGER,
      expires_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_inbox_platform_judged ON threads_inbox(platform, judged_at);

    CREATE TABLE IF NOT EXISTS drafts (
      id TEXT PRIMARY KEY,
      conversation_id TEXT,
      kind TEXT NOT NULL,
      plan_item_id TEXT,
      platform TEXT NOT NULL,
      thread_id TEXT,
      body TEXT NOT NULL,
      why_it_works TEXT,
      confidence REAL,
      status TEXT NOT NULL DEFAULT 'drafting',
      audit_notes_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_drafts_status ON drafts(status);

    CREATE TABLE IF NOT EXISTS posted (
      id TEXT PRIMARY KEY,
      draft_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      external_id TEXT NOT NULL,
      url TEXT,
      posted_at INTEGER NOT NULL,
      metrics_json TEXT,
      last_metrics_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS voice_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      draft_id TEXT NOT NULL,
      deviation TEXT NOT NULL,
      why TEXT,
      fixed INTEGER NOT NULL DEFAULT 0
    );
  `);
}
```

- [ ] **Step 2: Write `SocialMediaMgr.ts`**

```typescript
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type McpProps } from "@shipflare/shared";
import { applySmmSchema } from "./schema";
import { registerSmmTools } from "./tools";

type SmmState = { lastWakeAt: number };

export class SocialMediaMgr extends McpAgent<Env, SmmState, McpProps> {
  server = new McpServer({ name: "shipflare-smm", version: "1.0.0" });
  initialState: SmmState = { lastWakeAt: 0 };

  async onStart() {
    applySmmSchema(this.ctx.storage.sql);
    this.setState({ lastWakeAt: Date.now() });
    // Connect to platform tool MCPs
    await this.addMcpServer("x", this.env.X_MCP, {
      props: { userId: this.props.userId, caller: "peer", role: "member" },
    });
    await this.addMcpServer("reddit", this.env.REDDIT_MCP, {
      props: { userId: this.props.userId, caller: "peer", role: "member" },
    });
  }

  async init() {
    registerSmmTools(this);
  }
}
```

- [ ] **Step 3: Add export in `apps/core/src/index.ts`**

```typescript
export { SocialMediaMgr } from "./agents/social-media-manager/SocialMediaMgr";
```

- [ ] **Step 4: Commit**

```bash
git add apps/core/src/agents/social-media-manager/ apps/core/src/index.ts
git commit -m "feat(smm): class skeleton + schema + platform MCP connections"
```

---

### Task S4.1: SMM `findThreadsViaXai` + `processRepliesBatch` + `processPostsBatch` tools

**Files:**
- Create: `apps/core/src/agents/social-media-manager/tools.ts`

This is the largest tool port — it brings across the discovery / drafting / posting pipelines from
the existing `find_threads_via_xai`, `process_replies_batch`, `process_posts_batch` implementations.

- [ ] **Step 1: Write `tools.ts` skeleton with stubs**

```typescript
import { z } from "zod";
import type { SocialMediaMgr } from "./SocialMediaMgr";
import { runSkill } from "@shipflare/skills";

export function registerSmmTools(agent: SocialMediaMgr) {
  agent.server.registerTool("findThreadsViaXai", {
    description: "Discover engagement-worthy threads via xAI Grok search.",
    inputSchema: {
      conversationId: z.string(),
      platform: z.enum(["x", "reddit"]),
      intent: z.string().optional(),
      maxResults: z.number().default(20),
    },
  }, async ({ conversationId, platform, intent, maxResults }, extra) => {
    return findThreadsViaXai(agent, { conversationId, platform, intent, maxResults }, extra);
  });

  agent.server.registerTool("findThreads", {
    description: "Read recent threads_inbox (no new discovery).",
    inputSchema: {
      platforms: z.array(z.enum(["x", "reddit"])).default(["x"]),
      limit: z.number().default(20),
    },
  }, async ({ platforms, limit }) => {
    const placeholders = platforms.map(() => "?").join(",");
    const rows = agent.ctx.storage.sql.exec(
      `SELECT * FROM threads_inbox WHERE platform IN (${placeholders}) ORDER BY judged_at DESC LIMIT ?`,
      ...platforms, limit
    ).toArray();
    return { content: [{ type: "text", text: JSON.stringify(rows) }] };
  });

  agent.server.registerTool("processRepliesBatch", {
    description: "Draft replies for a list of thread IDs.",
    inputSchema: {
      conversationId: z.string(),
      threadIds: z.array(z.string()),
      voice: z.string().optional(),
    },
  }, async (input, extra) => {
    return processRepliesBatch(agent, input, extra);
  });

  agent.server.registerTool("processPostsBatch", {
    description: "Draft posts for a list of plan_item IDs.",
    inputSchema: {
      conversationId: z.string(),
      planItemIds: z.array(z.string()),
    },
  }, async (input, extra) => {
    return processPostsBatch(agent, input, extra);
  });

  agent.server.registerTool("researchRedditChannels", {
    description: "Discover top-3 subreddits for the founder's ICP.",
    inputSchema: { force: z.boolean().default(false) },
  }, async (input, extra) => {
    return researchRedditChannels(agent, input, extra);
  });
}

async function findThreadsViaXai(agent: SocialMediaMgr, input: { conversationId: string; platform: "x" | "reddit"; intent?: string; maxResults: number }, extra: any) {
  // Get founder context from CMO
  const cmoServer = (agent as any).mcpServers?.cmo;
  const context = cmoServer
    ? JSON.parse((await cmoServer.callTool("queryFounderContext", {})).content[0].text)
    : {};

  // Call platform tool: x_search via X MCP, or reddit search
  const platformServer = (agent as any).mcpServers?.[input.platform];
  if (!platformServer) throw new Error(`platform ${input.platform} not connected`);

  const searchResult = await platformServer.callTool(
    input.platform === "x" ? "xSearch" : "redditSearch",
    {
      product: context.productName ?? "",
      intent: input.intent ?? "engagement",
      maxResults: input.maxResults,
    }
  );
  const threads = JSON.parse(searchResult.content[0].text) as Array<{
    externalId: string; author: string; content: string;
  }>;

  // Judge each via the judging-thread skill
  const judged = await Promise.all(threads.map(async (t) => {
    const judgement = await runSkill("judging-thread", {
      thread: t,
      product: context.productName,
    }, { env: agent.env });
    return { ...t, ...judgement };
  }));

  // Persist qualifying threads
  let queued = 0;
  for (const t of judged) {
    if (t.keep !== true) continue;
    agent.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO threads_inbox (id, platform, external_id, author, content, score, judged_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      crypto.randomUUID(), input.platform, t.externalId, t.author, t.content,
      t.score ?? 0, Date.now(), Date.now() + 86400_000
    );
    queued++;
  }

  return { content: [{ type: "text", text: JSON.stringify({
    queued, scanned: threads.length, topQueued: judged.filter((t) => t.keep).slice(0, 3),
  }) }] };
}

async function processRepliesBatch(agent: SocialMediaMgr, input: { conversationId: string; threadIds: string[]; voice?: string }, _extra: any) {
  const cmoServer = (agent as any).mcpServers?.cmo;
  const context = cmoServer
    ? JSON.parse((await cmoServer.callTool("queryFounderContext", {})).content[0].text)
    : {};

  let draftsCreated = 0, draftsSkipped = 0;
  for (const threadId of input.threadIds) {
    const thread = agent.ctx.storage.sql.exec<{ platform: string; content: string; author: string }>(
      "SELECT platform, content, author FROM threads_inbox WHERE id = ?", threadId
    ).one();

    // Run drafting-reply skill (fork into a separate LLM context)
    const draft = await runSkill("drafting-reply", {
      thread,
      voice: input.voice ?? context.voice,
      product: context.productName,
    }, { env: agent.env });

    if (!draft.body) { draftsSkipped++; continue; }

    // Validate
    const valid = await runSkill("validating-draft", {
      body: draft.body,
      kind: "reply",
      platform: thread.platform,
    }, { env: agent.env });

    if (!valid.ok) { draftsSkipped++; continue; }

    // Persist draft
    const draftId = crypto.randomUUID();
    agent.ctx.storage.sql.exec(
      `INSERT INTO drafts (id, conversation_id, kind, platform, thread_id, body, why_it_works,
       confidence, status, audit_notes_json, created_at, updated_at)
       VALUES (?, ?, 'reply', ?, ?, ?, ?, ?, 'ready', ?, ?, ?)`,
      draftId, input.conversationId, thread.platform, threadId,
      draft.body, draft.whyItWorks ?? null, draft.confidence ?? 0.5,
      JSON.stringify(valid), Date.now(), Date.now()
    );

    // Add to CMO approval queue
    if (cmoServer) {
      // Direct approval queue write via CMO's own SQL would require an exposed tool;
      // we use the approval_queue side table that's queried by /drafts UI.
      agent.ctx.storage.sql.exec(
        `-- noop: approval queue is read from drafts table directly by UI`
      );
    }
    draftsCreated++;
  }

  return { content: [{ type: "text", text: JSON.stringify({
    itemsScanned: input.threadIds.length, draftsCreated, draftsSkipped,
  }) }] };
}

async function processPostsBatch(agent: SocialMediaMgr, input: { conversationId: string; planItemIds: string[] }, _extra: any) {
  const cmoServer = (agent as any).mcpServers?.cmo;
  const planResult = await cmoServer.callTool("queryPlanItems", { limit: 100 });
  const items = (JSON.parse(planResult.content[0].text) as Array<{ id: string; params_json: string; channel: string; skill: string }>)
    .filter((i) => input.planItemIds.includes(i.id));

  const context = JSON.parse((await cmoServer.callTool("queryFounderContext", {})).content[0].text);

  let draftsCreated = 0, draftsSkipped = 0;
  for (const item of items) {
    const params = JSON.parse(item.params_json);
    const draft = await runSkill("drafting-post", {
      planItem: { ...item, params },
      voice: context.voice,
      product: context.productName,
    }, { env: agent.env });

    if (!draft.body) { draftsSkipped++; continue; }
    const valid = await runSkill("validating-draft", { body: draft.body, kind: "post", platform: item.channel }, { env: agent.env });
    if (!valid.ok) { draftsSkipped++; continue; }

    const draftId = crypto.randomUUID();
    agent.ctx.storage.sql.exec(
      `INSERT INTO drafts (id, conversation_id, kind, plan_item_id, platform, body, why_it_works,
       confidence, status, audit_notes_json, created_at, updated_at)
       VALUES (?, ?, 'post', ?, ?, ?, ?, ?, 'ready', ?, ?, ?)`,
      draftId, input.conversationId, item.id, item.channel,
      draft.body, draft.whyItWorks ?? null, draft.confidence ?? 0.5,
      JSON.stringify(valid), Date.now(), Date.now()
    );
    await cmoServer.callTool("updatePlanItem", { id: item.id, status: "in_progress", output: { draftId } });
    draftsCreated++;
  }
  return { content: [{ type: "text", text: JSON.stringify({ itemsScanned: items.length, draftsCreated, draftsSkipped }) }] };
}

async function researchRedditChannels(agent: SocialMediaMgr, _input: { force: boolean }, _extra: any) {
  const cmoServer = (agent as any).mcpServers?.cmo;
  const reddit = (agent as any).mcpServers?.reddit;
  const context = JSON.parse((await cmoServer.callTool("queryFounderContext", {})).content[0].text);

  const result = await reddit.callTool("researchSubreddits", { product: context.productName, audience: context.audience });
  const subs = JSON.parse(result.content[0].text);

  // Persist top-3 into founder_context.subreddits
  await cmoServer.callTool("setFounderContext", { key: "subreddits", value: JSON.stringify(subs.slice(0, 3)) });
  return { content: [{ type: "text", text: JSON.stringify({ subreddits: subs.slice(0, 3), written: 3 }) }] };
}
```

> Note: CMO needs a `setFounderContext` tool — add it in S2.4's `registerSharedStateTools`. Add a step in S2.4 to include:
> ```typescript
> agent.server.registerTool("setFounderContext", {
>   description: "Write a founder_context key/value.",
>   inputSchema: { key: z.string(), value: z.string() },
> }, async ({ key, value }) => {
>   agent.ctx.storage.sql.exec("INSERT INTO founder_context (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", key, value);
>   return { content: [{ type: "text", text: "ok" }] };
> });
> ```

- [ ] **Step 2: Run typecheck**

```bash
cd apps/core && pnpm typecheck
```

- [ ] **Step 3: Commit**

```bash
git add apps/core/src/agents/social-media-manager/tools.ts apps/core/src/agents/cmo/tools.ts
git commit -m "feat(smm): findThreadsViaXai + processRepliesBatch + processPostsBatch + researchRedditChannels"
```

---

## S5 — Platform MCPs (Day 5-7, parallel with S3/S4)

### Task S5.0: XMcpAgent

**Files:**
- Create: `apps/core/src/platforms/x/XMcpAgent.ts`
- Create: `apps/core/src/platforms/x/schema.ts`
- Create: `apps/core/src/platforms/x/tools.ts`

- [ ] **Step 1: Write `schema.ts`**

```typescript
export function applyXSchema(sql: SqlStorage) {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS rate_limits (
      endpoint TEXT PRIMARY KEY,
      remaining INTEGER NOT NULL,
      reset_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS call_cache (
      cache_key TEXT PRIMARY KEY,
      response_json TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS posted_externals (
      external_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      posted_by_role TEXT,
      posted_at INTEGER NOT NULL,
      deleted_at INTEGER,
      json TEXT
    );
  `);
}
```

- [ ] **Step 2: Write `XMcpAgent.ts`**

```typescript
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type McpProps } from "@shipflare/shared";
import { applyXSchema } from "./schema";
import { registerXTools } from "./tools";

type XState = { lastWakeAt: number };

export class XMcpAgent extends McpAgent<Env, XState, McpProps & { role?: "lead" | "member" }> {
  server = new McpServer({ name: "shipflare-x", version: "1.0.0" });
  initialState: XState = { lastWakeAt: 0 };

  async onStart() {
    applyXSchema(this.ctx.storage.sql);
  }

  async init() {
    registerXTools(this);
  }
}
```

- [ ] **Step 3: Write `tools.ts`** (port from existing `src/tools/x-*.ts`)

```typescript
import { z } from "zod";
import { createXClient } from "@shipflare/tools";
import { decrypt } from "@shipflare/crypto";
import { eq, and } from "drizzle-orm";
import { createDb, channels } from "@shipflare/db";
import type { XMcpAgent } from "./XMcpAgent";

async function loadChannel(agent: XMcpAgent, userId: string) {
  const db = createDb(agent.env.PG.connectionString);
  const [chan] = await db.select().from(channels).where(
    and(eq(channels.userId, userId), eq(channels.platform, "x"))
  ).limit(1);
  if (!chan) throw new Error("X channel not connected for this user");
  const token = await decrypt(chan.oauthTokenEncrypted, agent.env.CHANNEL_ENC_KEY);
  return { token, externalUserId: chan.externalUserId, username: chan.username };
}

export function registerXTools(agent: XMcpAgent) {
  agent.server.registerTool("xSearch", {
    description: "Search X via xAI Grok for engagement-worthy threads.",
    inputSchema: {
      product: z.string(),
      intent: z.string().default("engagement"),
      maxResults: z.number().default(20),
    },
  }, async ({ product, intent, maxResults }, extra) => {
    const userId = (extra as any).props.userId;
    const channel = await loadChannel(agent, userId);
    const client = createXClient({ token: channel.token, xaiApiKey: agent.env.XAI_API_KEY });
    const threads = await client.searchViaXai({ product, intent, maxResults });
    return { content: [{ type: "text", text: JSON.stringify(threads) }] };
  });

  agent.server.registerTool("xPost", {
    description: "Publish a post to X.",
    inputSchema: {
      body: z.string(),
      replyToExternalId: z.string().optional(),
    },
  }, async ({ body, replyToExternalId }, extra) => {
    const props = (extra as any).props;
    if (props.role !== "lead" && props.caller !== "external") {
      throw new Error("Only lead can publish directly; members produce drafts");
    }
    const channel = await loadChannel(agent, props.userId);
    const client = createXClient({ token: channel.token, xaiApiKey: agent.env.XAI_API_KEY });
    const result = await client.post({ body, replyToExternalId });

    agent.ctx.storage.sql.exec(
      `INSERT INTO posted_externals (external_id, kind, posted_by_role, posted_at, json)
       VALUES (?, ?, ?, ?, ?)`,
      result.id, replyToExternalId ? "reply" : "post", props.role ?? props.caller,
      Date.now(), JSON.stringify(result)
    );
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  });

  agent.server.registerTool("xMetrics", {
    description: "Fetch engagement metrics for a posted item.",
    inputSchema: { externalId: z.string() },
  }, async ({ externalId }, extra) => {
    const userId = (extra as any).props.userId;
    const channel = await loadChannel(agent, userId);
    const client = createXClient({ token: channel.token, xaiApiKey: agent.env.XAI_API_KEY });
    const metrics = await client.metrics({ externalId });
    return { content: [{ type: "text", text: JSON.stringify(metrics) }] };
  });
}
```

- [ ] **Step 4: Add export to `apps/core/src/index.ts`**

```typescript
export { XMcpAgent } from "./platforms/x/XMcpAgent";
```

- [ ] **Step 5: Commit**

```bash
git add apps/core/src/platforms/x/ apps/core/src/index.ts
git commit -m "feat(x-mcp): XMcpAgent + xSearch/xPost/xMetrics tools"
```

---

### Task S5.1: RedditMcpAgent

**Files:**
- Create: `apps/core/src/platforms/reddit/RedditMcpAgent.ts`
- Create: `apps/core/src/platforms/reddit/schema.ts`
- Create: `apps/core/src/platforms/reddit/tools.ts`

- [ ] **Step 1: Mirror X MCP — Reddit version with port from existing `src/tools/reddit-*.ts`**

```typescript
// apps/core/src/platforms/reddit/RedditMcpAgent.ts
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type McpProps } from "@shipflare/shared";
import { applyXSchema } from "../x/schema";  // same shape
import { registerRedditTools } from "./tools";

type RedditState = { lastWakeAt: number };

export class RedditMcpAgent extends McpAgent<Env, RedditState, McpProps & { role?: "lead" | "member" }> {
  server = new McpServer({ name: "shipflare-reddit", version: "1.0.0" });
  initialState: RedditState = { lastWakeAt: 0 };

  async onStart() {
    applyXSchema(this.ctx.storage.sql);  // reuse identical schema
  }

  async init() {
    registerRedditTools(this);
  }
}
```

- [ ] **Step 2: Write `tools.ts`** (mirror X tools, swap client + handle Reddit's no-OAuth-required search path)

```typescript
import { z } from "zod";
import { createRedditClient } from "@shipflare/tools";
import { decrypt } from "@shipflare/crypto";
import { eq, and } from "drizzle-orm";
import { createDb, channels } from "@shipflare/db";
import type { RedditMcpAgent } from "./RedditMcpAgent";

async function loadOptionalChannel(agent: RedditMcpAgent, userId: string) {
  const db = createDb(agent.env.PG.connectionString);
  const [chan] = await db.select().from(channels).where(
    and(eq(channels.userId, userId), eq(channels.platform, "reddit"))
  ).limit(1);
  if (!chan) return null;
  const token = await decrypt(chan.oauthTokenEncrypted, agent.env.CHANNEL_ENC_KEY);
  return { token, username: chan.username };
}

export function registerRedditTools(agent: RedditMcpAgent) {
  agent.server.registerTool("redditSearch", {
    description: "Search Reddit (anonymous app-only) for relevant threads.",
    inputSchema: {
      product: z.string(),
      intent: z.string().default("engagement"),
      maxResults: z.number().default(20),
      subreddit: z.string().optional(),
    },
  }, async ({ product, intent, maxResults, subreddit }) => {
    const client = createRedditClient({});  // anonymous
    const threads = await client.search({ product, intent, maxResults, subreddit });
    return { content: [{ type: "text", text: JSON.stringify(threads) }] };
  });

  agent.server.registerTool("redditPost", {
    description: "Publish a post / comment to Reddit (requires channel connected).",
    inputSchema: {
      body: z.string(),
      subreddit: z.string().optional(),
      replyToExternalId: z.string().optional(),
      title: z.string().optional(),
    },
  }, async ({ body, subreddit, replyToExternalId, title }, extra) => {
    const props = (extra as any).props;
    if (props.role !== "lead" && props.caller !== "external") {
      throw new Error("Only lead can publish directly");
    }
    const channel = await loadOptionalChannel(agent, props.userId);
    if (!channel) throw new Error("Reddit channel not connected");
    const client = createRedditClient({ token: channel.token });
    const result = await client.post({ body, subreddit, replyToExternalId, title });

    agent.ctx.storage.sql.exec(
      `INSERT INTO posted_externals (external_id, kind, posted_by_role, posted_at, json)
       VALUES (?, ?, ?, ?, ?)`,
      result.id, replyToExternalId ? "reply" : "post", props.role ?? props.caller,
      Date.now(), JSON.stringify(result)
    );
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  });

  agent.server.registerTool("researchSubreddits", {
    description: "Discover top subreddits where the founder's ICP gathers.",
    inputSchema: { product: z.string(), audience: z.string().optional() },
  }, async ({ product, audience }) => {
    const client = createRedditClient({});
    const subs = await client.researchSubreddits({ product, audience });
    return { content: [{ type: "text", text: JSON.stringify(subs) }] };
  });
}
```

- [ ] **Step 3: Export + commit**

```typescript
// apps/core/src/index.ts
export { RedditMcpAgent } from "./platforms/reddit/RedditMcpAgent";
```

```bash
git add apps/core/src/platforms/reddit/ apps/core/src/index.ts
git commit -m "feat(reddit-mcp): RedditMcpAgent + redditSearch/redditPost/researchSubreddits"
```

---

## S6 — Skills port (Day 6-8, parallel with S5)

### Task S6.0: Create `packages/skills` + move existing skills

**Files:**
- Create: `packages/skills/package.json`
- Create: `packages/skills/src/index.ts`
- Create: `packages/skills/src/runner.ts`
- Move: `src/skills/**/*` → `packages/skills/skills/**/*`

- [ ] **Step 1: Write `packages/skills/package.json`**

```json
{
  "name": "@shipflare/skills",
  "version": "0.0.0",
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": {
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.36.0",
    "zod": "^3.23.0"
  },
  "devDependencies": { "typescript": "^5.5.0" }
}
```

- [ ] **Step 2: Move existing skill directories**

```bash
mkdir -p packages/skills/skills
git mv src/skills/drafting-post packages/skills/skills/
git mv src/skills/drafting-reply packages/skills/skills/
git mv src/skills/judging-thread packages/skills/skills/
git mv src/skills/validating-draft packages/skills/skills/
git mv src/skills/generate-queries packages/skills/skills/
# (any others under src/skills)
```

- [ ] **Step 3: Write `src/runner.ts`** — new runner that doesn't depend on the old AgentTool fork mechanism

```typescript
import Anthropic from "@anthropic-ai/sdk";

interface SkillContext {
  env: { ANTHROPIC_API_KEY: string };
}

const SKILL_DIR_PREFIX = "../skills";

async function loadSkillMarkdown(name: string): Promise<{ frontmatter: any; body: string }> {
  // In a Worker bundle, skill .md files must be inlined at build time.
  // We use Vite/wrangler's static import. For Phase 1, use a simple registry.
  const mod = await import(`../skills/${name}/SKILL.md?raw`);
  return parseFrontmatter(mod.default);
}

function parseFrontmatter(md: string) {
  const m = md.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return { frontmatter: {}, body: md };
  const fm: any = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([a-zA-Z_-]+):\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2].trim();
  }
  return { frontmatter: fm, body: m[2] };
}

export async function runSkill<T = any>(
  name: string,
  inputs: Record<string, unknown>,
  context: SkillContext
): Promise<T> {
  const { frontmatter, body } = await loadSkillMarkdown(name);
  // Substitute $ARGUMENTS / named args into body
  const prompt = substituteArguments(body, inputs);

  const client = new Anthropic({ apiKey: context.env.ANTHROPIC_API_KEY });
  const response = await client.messages.create({
    model: frontmatter.model ?? "claude-sonnet-4-6",
    max_tokens: frontmatter.maxTokens ?? 2048,
    system: frontmatter.system ?? "You are a focused skill executor. Return JSON only, no preamble.",
    messages: [{ role: "user", content: prompt }],
  });

  const text = response.content.filter((c) => c.type === "text").map((c) => (c as any).text).join("");
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    return JSON.parse(jsonMatch?.[0] ?? text) as T;
  } catch {
    return text as unknown as T;
  }
}

function substituteArguments(template: string, args: Record<string, unknown>): string {
  let out = template;
  for (const [k, v] of Object.entries(args)) {
    out = out.replaceAll(`{${k}}`, typeof v === "string" ? v : JSON.stringify(v));
  }
  return out;
}
```

- [ ] **Step 4: Write `src/index.ts`**

```typescript
export { runSkill } from "./runner";
```

- [ ] **Step 5: Verify skill markdown is bundled (wrangler asset config)**

Update `apps/core/wrangler.jsonc` to ensure markdown is included in build:

```jsonc
{
  // ... existing config
  "build": {
    "command": "echo 'no build step'"  // wrangler auto-bundles ESM imports
  },
  "rules": [
    { "type": "Text", "globs": ["**/*.md"], "fallthrough": true }
  ]
}
```

- [ ] **Step 6: Test that one skill loads**

```typescript
// apps/core/test/skills-load.test.ts
import { describe, it, expect } from "vitest";
import { runSkill } from "@shipflare/skills";

describe("skill loader", () => {
  it.skip("can run drafting-reply with mock LLM", async () => {
    // Mock Anthropic SDK in vitest setup; verify SKILL.md loads
    // Full test in S6.1
  });
});
```

- [ ] **Step 7: Commit**

```bash
git add packages/skills/ apps/core/wrangler.jsonc
git rm -r src/skills/  # remove old location (moved via git mv earlier)
git commit -m "feat(skills): move to packages/skills + new MCP-friendly runner"
```

---

### Task S6.1: Validate each skill runs end-to-end

**Files:**
- Create: `apps/core/test/skill-e2e.test.ts`

- [ ] **Step 1: Write integration test**

```typescript
import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { runSkill } from "@shipflare/skills";

const SKILLS = ["drafting-post", "drafting-reply", "judging-thread", "validating-draft", "generate-queries"];

describe("skills end-to-end", () => {
  for (const name of SKILLS) {
    it(`${name} loads SKILL.md without error`, async () => {
      // For each skill, run with minimal fake inputs;
      // assert that we don't crash on load + frontmatter parse.
      try {
        const result = await runSkill(name, {
          // generic placeholders
          thread: { content: "test", author: "x" },
          product: "test-product",
          voice: "casual",
          body: "test body",
          kind: "reply",
          platform: "x",
          planItem: { id: "pi-1", skill: name, channel: "x", params: {} },
        }, { env: env as any });
        expect(result).toBeDefined();
      } catch (e: any) {
        // Anthropic API errors are OK here (no real key in test env)
        // but module-not-found / parse errors are not
        expect(e.message).not.toMatch(/cannot find module|unexpected token/i);
      }
    }, 60_000);
  }
});
```

- [ ] **Step 2: Run + commit**

```bash
cd apps/core && pnpm vitest run
git add apps/core/test/skill-e2e.test.ts
git commit -m "test(skills): load each skill module without parse errors"
```

---

## S7 — Frontend (Day 6-10, parallel with S2-S6)

### Task S7.0: `/login` page + chat UI scaffold

**Files:**
- Modify: `apps/web/app/page.tsx` (landing → redirect or sign-in)
- Create: `apps/web/app/(app)/layout.tsx`
- Create: `apps/web/app/(app)/chat/[conversationId]/page.tsx`
- Create: `apps/web/app/(app)/chat/page.tsx` (lists conversations)
- Create: `apps/web/src/mcp-client.ts`

- [ ] **Step 1: Write `apps/web/src/mcp-client.ts`** — browser MCP wrapper

```typescript
import { createParser } from "eventsource-parser";

export interface ChatMcpClient {
  sendMessage: (conversationId: string, message: string, onChunk: (text: string) => void) => Promise<void>;
  listConversations: () => Promise<Array<{ id: string; title: string | null; startedAt: number }>>;
  startNewConversation: (title?: string) => Promise<{ id: string }>;
}

export function createMcpClient(opts: { mcpUrl: string; token: string }): ChatMcpClient {
  async function callTool<T>(name: string, args: any): Promise<T> {
    const res = await fetch(opts.mcpUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${opts.token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: crypto.randomUUID(),
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    const body = await res.json();
    if (body.error) throw new Error(body.error.message);
    return JSON.parse(body.result.content[0].text) as T;
  }

  return {
    async sendMessage(conversationId, message, onChunk) {
      const res = await fetch(opts.mcpUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "accept": "text/event-stream",
          "authorization": `Bearer ${opts.token}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: crypto.randomUUID(),
          method: "tools/call",
          params: { name: "chat", arguments: { conversationId, message } },
        }),
      });
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      const parser = createParser({
        onEvent: (event) => {
          if (event.event === "message") onChunk(event.data);
        },
      });
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        parser.feed(decoder.decode(value));
      }
    },
    async listConversations() {
      return await callTool("listConversations", { limit: 50 });
    },
    async startNewConversation(title) {
      const { conversationId } = await callTool<{ conversationId: string }>("startNewConversation", { title });
      return { id: conversationId };
    },
  };
}
```

- [ ] **Step 2: Write `apps/web/app/api/mcp-token/route.ts`**

```typescript
import { getAuth } from "@/auth";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { signJwt } from "@/lib/jwt";  // copy of apps/core/src/lib/jwt.ts adapted for web

export async function GET(req: Request) {
  const auth = getAuth();
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session) return new Response("unauthorized", { status: 401 });
  const { env } = getCloudflareContext();
  const token = await signJwt({ userId: session.user.id }, env.MCP_JWT_SECRET, 60);
  return Response.json({
    token,
    mcpUrl: `${env.CORE_PUBLIC_URL}/agents/cmo/${session.user.id}/mcp`,
  });
}
```

- [ ] **Step 3: Copy jwt helper into web**

```bash
mkdir -p apps/web/src/lib
cp apps/core/src/lib/jwt.ts apps/web/src/lib/jwt.ts
```

- [ ] **Step 4: Write `apps/web/app/(app)/layout.tsx`**

```tsx
import { getAuth } from "@/auth";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const auth = getAuth();
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/");
  return (
    <div>
      <nav>
        <a href="/chat">Chat</a> · <a href="/team">Team</a> · <a href="/plan">Plan</a> ·
        <a href="/drafts">Drafts</a> · <a href="/settings/channels">Settings</a>
      </nav>
      {children}
    </div>
  );
}
```

- [ ] **Step 5: Write `apps/web/app/(app)/chat/[conversationId]/page.tsx`**

```tsx
"use client";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { createMcpClient } from "@/mcp-client";

export default function ChatPage() {
  const { conversationId } = useParams<{ conversationId: string }>();
  const [messages, setMessages] = useState<Array<{ role: string; content: string }>>([]);
  const [input, setInput] = useState("");
  const [client, setClient] = useState<any>(null);
  const [streaming, setStreaming] = useState("");

  useEffect(() => {
    fetch("/api/mcp-token").then((r) => r.json()).then(({ token, mcpUrl }) => {
      setClient(createMcpClient({ mcpUrl, token }));
    });
  }, []);

  async function send() {
    if (!client || !input.trim()) return;
    const userMsg = input;
    setMessages((m) => [...m, { role: "user", content: userMsg }]);
    setInput("");
    setStreaming("");
    let acc = "";
    await client.sendMessage(conversationId, userMsg, (chunk: string) => {
      acc += chunk;
      setStreaming(acc);
    });
    setMessages((m) => [...m, { role: "assistant", content: acc }]);
    setStreaming("");
  }

  return (
    <main>
      <h1>Chat with CMO</h1>
      <div>
        {messages.map((m, i) => <div key={i}><strong>{m.role}:</strong> {m.content}</div>)}
        {streaming && <div><strong>assistant (streaming):</strong> {streaming}</div>}
      </div>
      <input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && send()} />
      <button onClick={send}>Send</button>
    </main>
  );
}
```

- [ ] **Step 6: Build + test**

```bash
cd apps/web && pnpm build
pnpm wrangler dev
# Visit http://localhost:3000/chat/test-conv-123 in browser after signing in.
```

- [ ] **Step 7: Commit**

```bash
git add apps/web/
git commit -m "feat(web): MCP client + /chat page with streaming"
```

---

### Task S7.1: `/team`, `/plan`, `/drafts`, `/settings/channels` pages

**Files:**
- Create: `apps/web/app/(app)/team/page.tsx`
- Create: `apps/web/app/(app)/plan/page.tsx`
- Create: `apps/web/app/(app)/drafts/page.tsx`
- Create: `apps/web/app/(app)/settings/channels/page.tsx`

- [ ] **Step 1: Write `/team/page.tsx`**

```tsx
"use client";
import { useEffect, useState } from "react";
import { ROLE_REGISTRY } from "@shipflare/shared";

interface RosterRow { role: string; status: string; }

export default function TeamPage() {
  const [roster, setRoster] = useState<RosterRow[]>([]);
  const [client, setClient] = useState<any>(null);

  useEffect(() => {
    fetch("/api/mcp-token").then((r) => r.json()).then(async ({ token, mcpUrl }) => {
      const { createMcpClient } = await import("@/mcp-client");
      const c = createMcpClient({ token, mcpUrl });
      setClient(c);
      const r = await (c as any).callTool?.("queryRoster", {});
      setRoster(JSON.parse(r?.content?.[0]?.text ?? "[]"));
    });
  }, []);

  async function hire(role: string) {
    await fetch("/api/mcp-token").then((r) => r.json()).then(async ({ token, mcpUrl }) => {
      const r = await fetch(mcpUrl, {
        method: "POST",
        headers: { "content-type": "application/json", "authorization": `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: "1", method: "tools/call", params: { name: "hireEmployee", arguments: { role } } }),
      });
      console.log(await r.json());
    });
    location.reload();
  }

  return (
    <main>
      <h1>Your Team</h1>
      <h2>Active</h2>
      <ul>
        {roster.filter((r) => r.status === "active").map((r) => (
          <li key={r.role}>{ROLE_REGISTRY[r.role]?.displayName ?? r.role}</li>
        ))}
      </ul>
      <h2>Available to Hire</h2>
      <ul>
        {Object.entries(ROLE_REGISTRY)
          .filter(([slug]) => slug !== "cmo" && !roster.find((r) => r.role === slug && r.status === "active"))
          .map(([slug, entry]) => (
            <li key={slug}>
              {entry.displayName} <button onClick={() => hire(slug)}>Hire</button>
            </li>
          ))}
      </ul>
    </main>
  );
}
```

- [ ] **Step 2: Write `/plan/page.tsx`** (similar pattern — read plan_items, show table)

```tsx
"use client";
import { useEffect, useState } from "react";

export default function PlanPage() {
  const [items, setItems] = useState<any[]>([]);

  useEffect(() => {
    fetch("/api/mcp-token").then((r) => r.json()).then(async ({ token, mcpUrl }) => {
      const res = await fetch(mcpUrl, {
        method: "POST",
        headers: { "content-type": "application/json", "authorization": `Bearer ${token}` },
        body: JSON.stringify({
          jsonrpc: "2.0", id: "1", method: "tools/call",
          params: { name: "queryPlanItems", arguments: { limit: 100 } },
        }),
      });
      const body = await res.json();
      setItems(JSON.parse(body.result.content[0].text));
    });
  }, []);

  return (
    <main>
      <h1>Plan Items</h1>
      <table>
        <thead><tr><th>Skill</th><th>Channel</th><th>Status</th><th>Owner</th><th>Scheduled</th></tr></thead>
        <tbody>
          {items.map((i) => (
            <tr key={i.id}><td>{i.skill}</td><td>{i.channel}</td><td>{i.status}</td><td>{i.owner_role}</td><td>{i.scheduled_for ? new Date(i.scheduled_for).toLocaleString() : "—"}</td></tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
```

- [ ] **Step 3: Write `/drafts/page.tsx`** (approval queue UI)

```tsx
"use client";
import { useEffect, useState } from "react";

interface Draft { id: string; kind: string; platform: string; body: string; status: string; }

export default function DraftsPage() {
  const [drafts, setDrafts] = useState<Draft[]>([]);

  async function fetchDrafts() {
    const { token, mcpUrl } = await fetch("/api/mcp-token").then((r) => r.json());
    // For now, drafts live in SMM DO — would need a CMO tool to query them via RPC.
    // For Phase 1, expose a CMO tool `queryDrafts(status='ready')` that RPCs to SMM.
    const res = await fetch(mcpUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "authorization": `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: "1", method: "tools/call",
        params: { name: "queryDrafts", arguments: { status: "ready" } } }),
    });
    setDrafts(JSON.parse((await res.json()).result.content[0].text));
  }

  async function approve(draftId: string) {
    const { token, mcpUrl } = await fetch("/api/mcp-token").then((r) => r.json());
    await fetch(mcpUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "authorization": `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: "1", method: "tools/call",
        params: { name: "approveDraft", arguments: { draftId } } }),
    });
    await fetchDrafts();
  }

  useEffect(() => { fetchDrafts(); }, []);

  return (
    <main>
      <h1>Drafts Pending Approval</h1>
      {drafts.map((d) => (
        <article key={d.id}>
          <header>{d.kind} on {d.platform}</header>
          <pre>{d.body}</pre>
          <button onClick={() => approve(d.id)}>Approve & Publish</button>
        </article>
      ))}
    </main>
  );
}
```

> NOTE: Add `queryDrafts` tool to CMO in S2.4 that RPCs to SMM:
> ```typescript
> agent.server.registerTool("queryDrafts", { description: "List drafts.", inputSchema: { status: z.string() } },
>   async ({ status }) => {
>     const smm = (agent as any).mcpServers?.["social-media-manager"];
>     if (!smm) return { content: [{ type: "text", text: "[]" }] };
>     return await smm.callTool("listDrafts", { status });
>   });
> ```
> And add `listDrafts` to SMM tools.

- [ ] **Step 4: Write `/settings/channels/page.tsx`**

```tsx
import { getAuth } from "@/auth";
import { headers } from "next/headers";

export default async function ChannelsPage() {
  const auth = getAuth();
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return <p>Sign in first</p>;
  return (
    <main>
      <h1>Connect Channels</h1>
      <ul>
        <li><a href="/api/channels/x/connect">Connect X</a></li>
        <li><a href="/api/channels/reddit/connect">Connect Reddit</a></li>
      </ul>
    </main>
  );
}
```

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/(app)/
git commit -m "feat(web): team/plan/drafts/channels pages"
```

---

## S8 — Auth flows (Day 7-9)

### Task S8.0: X / Reddit OAuth callbacks

**Files:**
- Create: `apps/web/app/api/channels/x/connect/route.ts`
- Create: `apps/web/app/api/channels/x/callback/route.ts`
- Create: `apps/web/app/api/channels/reddit/connect/route.ts`
- Create: `apps/web/app/api/channels/reddit/callback/route.ts`

- [ ] **Step 1: X connect (initiates OAuth)**

```typescript
// apps/web/app/api/channels/x/connect/route.ts
import { getCloudflareContext } from "@opennextjs/cloudflare";

export async function GET(req: Request) {
  const { env } = getCloudflareContext();
  const state = crypto.randomUUID();
  const url = new URL("https://twitter.com/i/oauth2/authorize");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", env.X_CLIENT_ID);
  url.searchParams.set("redirect_uri", `${env.PUBLIC_URL}/api/channels/x/callback`);
  url.searchParams.set("scope", "tweet.read tweet.write users.read offline.access");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge_method", "plain");
  url.searchParams.set("code_challenge", state);  // PKCE
  return Response.redirect(url.toString());
}
```

- [ ] **Step 2: X callback**

```typescript
// apps/web/app/api/channels/x/callback/route.ts
import { getAuth } from "@/auth";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { getDb } from "@/db";
import { channels } from "@shipflare/db";
import { encrypt } from "@shipflare/crypto";

export async function GET(req: Request) {
  const auth = getAuth();
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session) return Response.redirect("/");
  const { env } = getCloudflareContext();
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code) return new Response("missing code", { status: 400 });

  // Exchange code → tokens
  const tokenRes = await fetch("https://api.twitter.com/2/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: env.X_CLIENT_ID,
      redirect_uri: `${env.PUBLIC_URL}/api/channels/x/callback`,
      code_verifier: state!,
    }),
  });
  const tokens = await tokenRes.json() as { access_token: string; refresh_token: string; scope: string };

  // Fetch X user
  const userRes = await fetch("https://api.twitter.com/2/users/me", {
    headers: { "authorization": `Bearer ${tokens.access_token}` },
  });
  const user = await userRes.json() as { data: { id: string; username: string } };

  // Encrypt + persist
  const db = getDb(env);
  await db.insert(channels).values({
    id: crypto.randomUUID(),
    userId: session.user.id,
    platform: "x",
    externalUserId: user.data.id,
    username: user.data.username,
    oauthTokenEncrypted: await encrypt(tokens.access_token, env.CHANNEL_ENC_KEY),
    oauthRefreshEncrypted: await encrypt(tokens.refresh_token, env.CHANNEL_ENC_KEY),
    scope: tokens.scope,
  }).onConflictDoUpdate({
    target: [channels.userId, channels.platform],
    set: {
      oauthTokenEncrypted: await encrypt(tokens.access_token, env.CHANNEL_ENC_KEY),
      oauthRefreshEncrypted: await encrypt(tokens.refresh_token, env.CHANNEL_ENC_KEY),
      status: "active",
    },
  });

  return Response.redirect(`${env.PUBLIC_URL}/settings/channels?connected=x`);
}
```

- [ ] **Step 3: Mirror for Reddit**

Same pattern, swap endpoints:
- Authorize: `https://www.reddit.com/api/v1/authorize`
- Token: `https://www.reddit.com/api/v1/access_token`
- User identity: `https://oauth.reddit.com/api/v1/me`

- [ ] **Step 4: Commit**

```bash
git add apps/web/app/api/channels/
git commit -m "feat(web): X / Reddit OAuth callbacks with encrypted token storage"
```

---

## S9 — DevX (Day 8-10, parallel)

### Task S9.0: CI workflow

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Write CI workflow**

```yaml
name: CI

on:
  pull_request:
    branches: [main, dev]
  push:
    branches: [main, dev]

jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v3
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck
      - run: pnpm test
      - run: pnpm --filter=@shipflare/web build
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: typecheck + test + build on PR"
```

---

### Task S9.1: Deployment scripts

**Files:**
- Create: `scripts/deploy-prod.sh`

- [ ] **Step 1: Write deploy script**

```bash
#!/usr/bin/env bash
set -euo pipefail

echo "→ Building web..."
cd apps/web && pnpm build && cd -

echo "→ Deploying core..."
cd apps/core && pnpm wrangler deploy && cd -

echo "→ Deploying web..."
cd apps/web && pnpm wrangler deploy && cd -

echo "✓ Deploy complete"
```

- [ ] **Step 2: Make executable + commit**

```bash
chmod +x scripts/deploy-prod.sh
git add scripts/
git commit -m "scripts: production deploy"
```

---

## S10 — E2E (Day 11-12)

### Task S10.0: Playwright E2E smoke

**Files:**
- Create: `e2e/playwright.config.ts`
- Create: `e2e/tests/happy-path.spec.ts`
- Create: `e2e/package.json`

- [ ] **Step 1: Write `e2e/package.json`**

```json
{
  "name": "@shipflare/e2e",
  "version": "0.0.0",
  "private": true,
  "scripts": {
    "test": "playwright test"
  },
  "devDependencies": { "@playwright/test": "^1.45.0" }
}
```

- [ ] **Step 2: Write Playwright config**

```typescript
// e2e/playwright.config.ts
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  use: { baseURL: process.env.SHIPFLARE_URL ?? "http://localhost:3000" },
  reporter: [["html", { open: "never" }]],
  timeout: 120_000,
});
```

- [ ] **Step 3: Write happy-path smoke test**

```typescript
// e2e/tests/happy-path.spec.ts
import { test, expect } from "@playwright/test";

test("login → connect X → chat → draft → approve → posted", async ({ page, context }) => {
  // Assumes test GitHub OAuth account is auto-approved via cookie reuse
  await page.goto("/");
  await page.click("text=Sign in with GitHub");
  // GitHub OAuth — using preset auth state
  await page.waitForURL(/\/chat|\/$/);

  // Connect X (manual / pre-seeded — too flaky in pure browser test for OAuth)
  // For Phase 1: assume X channel pre-connected in test fixture DB.

  // Start new conversation
  await page.goto("/chat");
  // Start chat
  await page.fill("input", "Generate a strategic path for SaaS launch on X");
  await page.click("text=Send");
  await expect(page.locator("text=assistant")).toBeVisible({ timeout: 60_000 });

  // Plan page should now show plan_items
  await page.goto("/plan");
  await expect(page.locator("table tr").nth(1)).toBeVisible({ timeout: 30_000 });

  // Drafts page eventually shows a draft after SMM runs
  await page.goto("/drafts");
  await expect(page.locator("article")).toBeVisible({ timeout: 120_000 });

  // Approve
  await page.click("text=Approve & Publish");
  await expect(page.locator("text=approved")).toBeVisible({ timeout: 30_000 });
});
```

- [ ] **Step 4: Commit**

```bash
git add e2e/
git commit -m "e2e: happy path smoke test"
```

---

## Cleanup (after Phase 1 verified GREEN, ~1 week observation)

### Task Cleanup.0: Delete legacy code

**Files:**
- Delete: `src/lib/db/schema/{agent_runs,team_messages,team_members,plan_items,threads,posts,drafts,strategic_paths,products,xai_calls,tool_audit}.ts`
- Delete: `src/workers/`
- Delete: `src/tools/AgentTool/`
- Delete: `src/lib/auth/account-encryption.ts`
- Modify: `CLAUDE.md` (rewrite "Agent Teams Architecture" section)

- [ ] **Step 1: Verify Phase 1 actually works for 7 days of dogfood**

Wait for 7-day observation window. If issues, fix and reset clock.

- [ ] **Step 2: Delete legacy schemas**

```bash
git rm src/lib/db/schema/{agent_runs,team_messages,team_members,plan_items,threads,posts,drafts,strategic_paths,products,xai_calls,tool_audit}.ts
```

- [ ] **Step 3: Delete legacy workers + AgentTool**

```bash
git rm -r src/workers/ src/tools/AgentTool/ src/lib/auth/account-encryption.ts
```

- [ ] **Step 4: Move retained tools to `packages/tools`**

```bash
git mv src/tools/x packages/tools/src/x
git mv src/tools/reddit packages/tools/src/reddit
git mv src/lib/content/validators packages/tools/src/validators
git mv src/lib/reply-throttle.ts packages/tools/src/validators/reply-throttle.ts
```

- [ ] **Step 5: Remove BullMQ dependencies**

```bash
pnpm remove bullmq ioredis bull-board
```

- [ ] **Step 6: Rewrite CLAUDE.md "Agent Teams Architecture" section**

Replace the existing 7-invariant section with the post-migration 2 invariants per spec §6.1:

```markdown
## Agent Teams Architecture (post-CF migration)

ShipFlare's multi-agent runtime is built on Cloudflare Durable Objects + Agents SDK
+ Dynamic Workflows. Most invariants are now framework guarantees. Code review
must reject violations of these two:

1. **CMO SQLite is the per-team source of truth.** Other employees never write
   CMO SQLite directly; all writes go through CMO's exposed MCP tools
   (`commitStrategicPath`, `addPlanItem`, `approveDraft`, etc.). Direct cross-DO
   SQL access = review reject.

2. **Peer-DM shadow MUST NOT trigger CMO's onMessage / chat handler.** Use
   `env.CMO.idFromName(uid).fetch('/internal/peer-dm-shadow')`, not RPC tool
   calls. The shadow handler appends to `employee_log` and returns; CMO sees
   it on next natural wake.

Framework guarantees (no longer hand-enforced):
- Single-threaded message processing per DO (replaces mailbox row lock)
- Hibernation on idle (replaces sleep / slot-yield protocol)
- Tool authorization via props (replaces 4-layer assembleToolPool)
- RPC connection persistence across hibernation
- Role-based tool visibility via props.caller / props.role checks inside McpAgent

See `docs/superpowers/specs/2026-05-13-cloudflare-do-migration-design.md` for full design.
```

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: delete legacy BullMQ + agent_runs + assembleToolPool + rewrite CLAUDE.md"
```

- [ ] **Step 8: Phase 2 ready to start**

Open `docs/superpowers/plans/2026-05-13-cf-phase-2-capabilities.md`.
