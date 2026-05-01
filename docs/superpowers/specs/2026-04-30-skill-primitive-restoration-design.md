# Skill primitive restoration — design

**Date**: 2026-04-30
**Author**: ShipFlare Dev (brainstorming with Claude)
**Status**: design — ready for plan
**Related**: cleanup of Phase 6 absorption (`src/lib/plan-execute-dispatch.ts:80-84`),
sets up future encouraging-reply fix (Phase 2+)

---

## 1. Background

ShipFlare currently runs a two-primitive multi-agent system: **Tool** + **Agent**.
Claude Code's reference engine (vendored in `engine/`) ships three primitives:
**Tool** + **Agent** + **Skill**. ShipFlare's port deliberately stripped the
Skill primitive in two places:

1. `src/tools/AgentTool/loader.ts:67-80` — `'skills'` listed in `DROPPED_FIELDS`,
   so `AGENT.md` frontmatter declarations are silently discarded with a warning.
2. `src/lib/plan-execute-dispatch.ts:80-84` — Phase 6 of the agent-cleanup
   migration deleted `draft-single-reply` and `draft-single-post` skills,
   absorbing their logic back into `community-manager` and `post-writer`
   `AGENT.md` files.

The absorption was reasonable at the time (no callers, no skill loader). But
without the Skill primitive, every "atomic sub-task" (judging an opportunity,
drafting one reply in one archetype, validating tone) lives inside a monolithic
Agent prompt. This produces three concrete pains:

- **Mega-agent prompts**: `community-manager/AGENT.md` is 232 lines plus 4
  reference docs (~600 total). Every turn pays the cache cost of the whole
  prompt even when the LLM is doing one tiny step.
- **No per-sub-task model override**: cheap Haiku for `validate-and-repair-tone`
  while the writer runs Sonnet is impossible — the writer model handles
  everything in its turn budget.
- **No fork isolation**: a sub-task that wants its own token budget (iterative
  rewrite, tool-heavy validation) has to be promoted to a full new Agent and
  spawned via `Task`, paying full system-prompt cache cost on each spawn.

The downstream visible symptom: reply drafts stay in sermon / corrective register
even though `reply-quality-bar.md` bans those patterns explicitly. The model
ignores the rules at write time because the prompt is too big to internalize.
This spec is **not** the fix for that — it's the architectural unblocking that
makes the fix (Phase 2: extract `judge-reply-opportunity` + `drafting-encouraging-replies`
+ `validate-and-repair-tone` skills) cheap.

## 2. Goals (Phase 1)

Restore the Skill primitive as a first-class part of ShipFlare's multi-agent
system, aligned with Claude Code's engine and Anthropic's official skill spec.
Phase 1 is **infrastructure only** — no business agent migration.

### 2.1 Specific outcomes

1. Three primitives exist and load cleanly: Tool, Agent, **Skill** (new).
2. `loadSkillsDir.ts` discovers markdown skills under `src/skills/<name>/SKILL.md`.
3. `registerBundledSkill()` API supports programmatic TS skills (registered but
   no real bundled skill ships in Phase 1).
4. `SkillTool` is a regular tool any agent can be given access to via its
   `tools:` allowlist. When an agent has SkillTool, it can mid-turn invoke any
   registered skill.
5. Agent `AGENT.md` frontmatter `skills: [...]` works as a preload hint —
   declared skills' content is injected into the agent's initial conversation
   when it spawns.
6. Three skill execution modes implemented: `inline-preload` (via agent
   frontmatter), `inline mid-turn` (via SkillTool with `context: inline`),
   `fork` (via SkillTool with `context: fork` — spawns isolated sub-agent).
7. One end-to-end smoke skill (`_demo-echo-skill`) exercises all three modes
   in tests.

### 2.2 Non-goals (Phase 1)

- No business agent migration (community-manager, post-writer, coordinator,
  etc. remain untouched). Phase 2+ work.
- No real bundled skills shipped. The `registerBundledSkill()` API is wired
  up and the import-side-effect path exists, but `src/skills/_bundled/` is
  empty.
- No CLI scaffold (`pnpm skill:new`). Manual template copy is the Phase 1
  authoring path.
- No skill-creator meta-skill.
- No MCP skill builders, plugin skills, hooks-in-frontmatter,
  `disable-model-invocation`, `user-invocable` — all stripped, matching the
  precedent set by ShipFlare's AgentTool port (`loader.ts:1-4`).
- No agent-side ACL on which skills an agent can invoke. Aligned with CC
  engine: any agent with SkillTool in its tools list can invoke any registered
  skill. The `description` field plus the agent's system prompt is the soft
  guard. (Decision route W in brainstorming: industry-standard alignment over
  ShipFlare-specific stricter ACL.)

## 3. Architecture

### 3.1 Three-primitive topology

```
                          ┌───────────────────────────┐
                          │  src/core/query-loop.ts   │
                          │  runAgent(config, prompt) │  main agent loop
                          │  (already exists)         │
                          └─────────────┬─────────────┘
                                        │
              ┌─────────────────────────┼─────────────────────────┐
              ▼                         ▼                         ▼
       ┌─────────────┐           ┌─────────────┐           ┌─────────────┐
       │    TOOL     │           │    AGENT    │           │    SKILL    │
       │             │           │             │           │   (NEW)     │
       └─────────────┘           └─────────────┘           └─────────────┘

       Pure capability           Persona + loop            Prompt unit
       buildTool()               markdown + frontmatter    markdown + frontmatter
       Zod schema                spawnSubagent path        loadSkillsDir + SkillTool

       src/tools/<X>Tool/        src/tools/AgentTool/      src/tools/SkillTool/
       src/tools/registry.ts        AgentTool.ts              SkillTool.ts
                                    loader.ts                 loadSkillsDir.ts
                                    registry.ts               registry.ts
                                    spawn.ts                  prompt.ts
                                    agents/<name>/         src/skills/<name>/
                                       AGENT.md                  SKILL.md
                                       references/               references/
                                                                 scripts/
                                                                 assets/
                                                                 evals/
```

### 3.2 Primitive comparison

| Aspect | Tool | Agent | Skill |
|---|---|---|---|
| Registration | `src/tools/registry.ts` static + MCP runtime | filesystem scan `src/tools/AgentTool/agents/*/AGENT.md` | filesystem scan `src/skills/*/SKILL.md` + `registerBundledSkill()` |
| Frontmatter | n/a (code) | `tools / model / maxTurns / references / shared-references / skills` | `name / description / context / allowed-tools / model / maxTurns / when-to-use / argument-hint / paths` |
| Mid-turn invocable? | yes (it's a tool) | yes (via Task tool, depth-limited) | yes (via SkillTool — provided agent's `tools:` includes SkillTool) |
| Pre-loaded into a caller's context? | no | no | yes — when a caller agent's frontmatter `skills: [name]` lists it |
| Execution modes | one (call() returns) | one (full agent loop) | three: inline-preload, inline mid-turn, fork |
| Per-invocation model override? | no | no (frontmatter `model:` is static) | yes (frontmatter `model:` overrides caller agent's model in fork mode) |
| Tool-set scoping? | n/a | `tools:` whitelist | `allowed-tools:` whitelist (fork mode only; inline modes inherit caller's tool set) |
| ACL on who can invoke? | agent's `tools:` lists which | spawn depth limit (3); subagent_type lookup | none — any agent with SkillTool tool access can invoke any registered skill |

### 3.3 Why three modes, not two

Q2 in brainstorming initially settled on D (preload + fork only, skip mid-turn
inline). Final decision (after re-research): keep all three for full CC
behavior compatibility. Mid-turn inline is what CC defaults to, and stripping
it would mean a CC-authored skill with `context: inline` (the default) would
behave differently in ShipFlare than in CC. Cost: ~150 LOC of `newMessages`
injection logic in SkillTool. Benefit: 100% engine compatibility, future merge
friendliness.

## 4. Skill folder structure

Aligned with Anthropic's official spec
([best-practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices))
and Claude Code engine conventions.

```
src/skills/
└── <skill-name>/
    ├── SKILL.md              REQUIRED — frontmatter + main prompt body
    ├── references/           optional — markdown loaded on demand by Claude
    │                                    when SKILL.md body links to it
    ├── scripts/              optional — executable code, run via bash, output
    │                                    captured (does not consume context tokens)
    ├── assets/               optional — output-side files (templates, fixed
    │                                    strings, icons)
    ├── evals/                optional — test scenarios, format per
    │                                    https://github.com/anthropics/skills
    │   └── evals.json
    └── __tests__/            ShipFlare convention — Vitest unit tests for
        └── *.test.ts                    skill loading + behavior
```

**Naming**: for **production skills**, gerund form preferred
(`drafting-encouraging-replies`, `judging-reply-opportunity`) per Anthropic
best practice. Verb form (`debug`, `simplify`) acceptable for ports of
CC bundled-skill-style names. Validator (Zod): `[a-z0-9-_]+`, max 64
chars, not "anthropic" / "claude".

**Internal-only skills**: prefix with underscore (`_demo-echo-skill`,
`_bundled/`). Convention mirrors `src/tools/AgentTool/agents/_shared/` —
underscore = "infrastructure, not for production discovery." Naming
rules above (gerund preferred) do **not** apply to underscore-prefixed
skills. Loader treats them identically to public skills; the prefix is a
human signal only and not parsed.

## 5. SKILL.md frontmatter schema

```yaml
---
# === REQUIRED (Anthropic platform spec) ===
name: drafting-encouraging-replies
  # max 64 chars, [a-z0-9-], no XML, not "anthropic" / "claude"
description: |
  Drafts a single encouraging X reply for threads where the OP is shipping,
  launching, or struggling. Anchors on the author's progress with no
  generalized claims. Use when judge-reply-opportunity returns
  signal=progress_post or vulnerable_post.
  # max 1024 chars, third-person, what + when

# === OPTIONAL (CC engine standard) ===
context: fork
  # inline | fork. Default: inline.
  # inline = mid-turn injection into caller's conversation (newMessages)
  # fork   = spawn isolated sub-agent via runAgent
allowed-tools:
  - validate_draft
  - draft_reply
  # Whitelist of tool names. Fork mode: this exact set is the sub-agent's
  # tool pool. Inline mode: caller inherits these (advisory; CC does not
  # enforce in inline mode).
model: claude-haiku-4-5
  # Optional. Fork mode: overrides caller's model. Inline mode: ignored
  # (caller's model continues).
maxTurns: 4
  # Optional. Fork mode: turn budget for sub-agent. Default: caller's
  # remaining budget.
when-to-use: |
  Pick this when the OP is sharing concrete progress on their own work.
  Skip if the OP is asking a tool question (use drafting-data-add-replies)
  or making meta-commentary (use question-extender or skip).
  # Optional. Extra semantic hint visible in SkillTool's prompt to the model
  # when picking which skill to invoke.
argument-hint: "<threadId> <signal>"
  # Optional. Hint shown to the model in SkillTool's description.
paths:
  - "**/community-manager/**"
  # Optional. Globs limiting which agent contexts may invoke this skill
  # (CC convention). Phase 1: parsed and stored, not enforced.
---

# Drafting an encouraging reply

(Main prompt body — must be under 500 lines per Anthropic guidance)

For long-format guidance, see:
- [Examples of good replies](references/examples.md)
- [Anti-patterns to avoid](references/anti-patterns.md)
```

**Progressive disclosure**: SKILL.md body links to `references/foo.md`
files via standard markdown links. Claude reads referenced files on demand
(via Read tool) when the body cites them — they consume zero tokens until
read. This is the Anthropic-recommended pattern; do not use a `references:`
frontmatter field for skills (that's a ShipFlare-only AgentTool extension
that does not apply to skills).

**Required body structure** (Anthropic guidance, soft-enforced):
- Body ≤ 500 lines
- Reference files ≤ 1 level deep from SKILL.md (no nested chains)
- Reference files > 100 lines should include a TOC at the top

## 6. Loader internals

### 6.1 Discovery + parsing

```ts
// src/tools/SkillTool/loadSkillsDir.ts
async function loadSkillsDir(rootDir: string): Promise<SkillCommand[]> {
  const skillDirs = await discoverSkillDirs(rootDir);
  const loaded = await Promise.all(
    skillDirs.map(dir => loadSkill(dir)),
  );
  return loaded.filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
}

async function loadSkill(dir: string): Promise<SkillCommand | null> {
  const skillMdPath = path.join(dir, 'SKILL.md');
  const raw = await fs.readFile(skillMdPath, 'utf8');
  const { frontmatter, body } = parseFrontmatter(raw);
  const validated = SkillFrontmatterSchema.parse(frontmatter);

  return {
    type: 'prompt' as const,
    name: validated.name,
    description: validated.description,
    whenToUse: validated['when-to-use'],
    context: validated.context ?? 'inline',
    allowedTools: validated['allowed-tools'] ?? [],
    model: validated.model,
    maxTurns: validated.maxTurns,
    paths: validated.paths,
    argumentHint: validated['argument-hint'],
    sourcePath: skillMdPath,
    skillRoot: dir,

    async getPromptForCommand(args: string, ctx: ToolContext): Promise<string> {
      return substituteArguments(body, args);
    },
  };
}
```

`discoverSkillDirs` walks `rootDir` looking for any directory containing a
`SKILL.md`. Mirrors the AgentTool pattern (`src/tools/AgentTool/loader.ts:444`
`discoverAgentDirs`). Skips directories starting with `.`.

### 6.2 Bundled skill registration

```ts
// src/tools/SkillTool/registry.ts
const bundledRegistry: SkillCommand[] = [];

interface BundledSkillInput {
  name: string;
  description: string;
  context?: 'inline' | 'fork';
  allowedTools?: string[];
  model?: string;
  maxTurns?: number;
  // Programmatic skills generate their prompt dynamically.
  getPromptForCommand: (args: string, ctx: ToolContext) => string | Promise<string>;
}

export function registerBundledSkill(input: BundledSkillInput): void {
  bundledRegistry.push({
    type: 'prompt' as const,
    source: 'bundled',
    ...input,
    context: input.context ?? 'inline',
    allowedTools: input.allowedTools ?? [],
    skillRoot: undefined,  // bundled skills have no filesystem dir
  });
}

export async function getAllSkills(rootDir?: string): Promise<SkillCommand[]> {
  // Side-effect import triggers all registerBundledSkill() calls.
  // Empty barrel in Phase 1 (no real bundled skills shipped).
  await import('@/skills/_bundled');

  const fileSkills = rootDir ? await loadSkillsDir(rootDir) : [];

  // Bundled wins on name conflict (rare; convention is unique names).
  const seen = new Set(bundledRegistry.map(s => s.name));
  const merged = [
    ...bundledRegistry,
    ...fileSkills.filter(s => !seen.has(s.name)),
  ];
  return merged;
}
```

### 6.3 Filesystem watcher

Mirror `src/tools/AgentTool/registry.ts:73` `ensureWatcher()` pattern —
recursive `fs.watch` with 200ms debounce, watcher disabled via
`SHIPFLARE_DISABLE_SKILL_WATCHER=1` for tests. Watcher only fires for
filesystem skills; bundled registry is immutable after module init.

### 6.4 Frontmatter validation

```ts
const SkillFrontmatterSchema = z.object({
  name: z.string()
    .min(1).max(64)
    .regex(/^[a-z0-9-]+$/)
    .refine(n => !['anthropic', 'claude'].includes(n)),
  description: z.string().min(1).max(1024),
  context: z.enum(['inline', 'fork']).optional(),
  'allowed-tools': z.array(z.string()).optional(),
  model: z.string().min(1).optional(),
  maxTurns: z.number().int().positive().optional(),
  'when-to-use': z.string().optional(),
  'argument-hint': z.string().optional(),
  paths: z.array(z.string()).optional(),
}).passthrough();
```

Unknown fields pass through (forwards-compat with future CC engine fields).
A loader-level warning logs unknown keys for visibility, mirroring how
`src/tools/AgentTool/loader.ts:80` handles its `DROPPED_FIELDS`.

## 7. SkillTool surface

### 7.1 Tool definition

```ts
// src/tools/SkillTool/SkillTool.ts
const SKILL_TOOL_NAME = 'skill';

const skillTool = buildTool({
  name: SKILL_TOOL_NAME,
  description: getSkillToolDescription,  // injected with skill roster
  inputSchema: z.object({
    skill: z.string(),
    args: z.string().optional(),
  }),
  outputSchema: z.union([
    z.object({
      success: z.boolean(),
      commandName: z.string(),
      status: z.literal('inline'),
    }),
    z.object({
      success: z.boolean(),
      commandName: z.string(),
      status: z.literal('forked'),
      result: z.string(),
    }),
  ]),
  call: async (input, ctx) => { /* see 7.2 */ },
});
```

`getSkillToolDescription` reads `getAllSkills()` and renders a roster
(name + description + when-to-use) for each registered skill, mirroring
`prompt.ts` for AgentTool's roster.

### 7.2 Call dispatch

```ts
async call({ skill, args }, ctx, callbacks, parentMessage) {
  const all = await getAllSkills(SKILLS_ROOT);
  const cmd = all.find(s => s.name === skill);
  if (!cmd) throw new Error(`Unknown skill: ${skill}`);

  if (cmd.context === 'fork') {
    return executeForkedSkill(cmd, args ?? '', ctx, callbacks, parentMessage);
  }
  // default: inline mid-turn
  return executeInlineSkill(cmd, args ?? '', ctx, parentMessage);
}
```

#### Inline mid-turn (`executeInlineSkill`)

```ts
async function executeInlineSkill(cmd, args, ctx, parentMessage) {
  const content = await cmd.getPromptForCommand(args, ctx);
  const metadata = formatSkillLoadingMetadata(cmd.name);

  const newMessages = [
    createUserMessage({
      content: [
        { type: 'text', text: metadata },
        { type: 'text', text: content },
      ],
      isMeta: true,
    }),
  ];

  return {
    data: {
      success: true,
      commandName: cmd.name,
      status: 'inline' as const,
    },
    newMessages,
  };
}
```

The `newMessages` returned here are appended to the caller's conversation
by `runAgent`'s tool-result handler (CC engine pattern,
`engine/tools/SkillTool/SkillTool.ts:733-755`). Caller continues in its
existing turn budget with the skill content now in context.

#### Forked (`executeForkedSkill`)

```ts
async function executeForkedSkill(cmd, args, ctx, callbacks, parentMessage) {
  const content = await cmd.getPromptForCommand(args, ctx);

  // Build a minimal sub-agent definition from the skill's frontmatter.
  const subAgentDef: AgentDefinition = {
    name: `skill:${cmd.name}`,
    description: cmd.description,
    tools: cmd.allowedTools,
    model: cmd.model,
    maxTurns: cmd.maxTurns ?? DEFAULT_SKILL_FORK_MAX_TURNS,
    systemPrompt: content,
    sourcePath: cmd.sourcePath ?? `<bundled:${cmd.name}>`,
  };

  const result = await spawnSubagent(
    subAgentDef,
    args,                    // user message = the args
    ctx,
    callbacks,
  );

  return {
    data: {
      success: true,
      commandName: cmd.name,
      status: 'forked' as const,
      result: typeof result.result === 'string'
        ? result.result
        : JSON.stringify(result.result),
    },
  };
}
```

Forked sub-agent gets:
- Its own AbortController (`createChildContext` — already in
  `src/tools/AgentTool/spawn.ts:137`)
- Its own turn budget (from `cmd.maxTurns`)
- Its own model (`cmd.model` overrides caller)
- Its own tool pool (`cmd.allowedTools` resolves against `src/tools/registry.ts`)
- Inherits parent's depth + 1 (subject to `MAX_SPAWN_DEPTH = 3`)

### 7.3 Permission flow

CC-aligned (route W from brainstorming): permission check is **only** on
SkillTool itself, not per-skill.

```
agent's tools: [..., skill]    ← agent CAN invoke any skill
agent's tools: [...]           ← agent CANNOT invoke any skill
```

No per-skill ACL. Description + system prompt + (optional) `paths` glob are
the soft guards. `paths` is parsed but not enforced in Phase 1 (filed as
follow-up if cross-agent skill invocation becomes a real noise source).

## 8. Agent ↔ Skill bridge

### 8.1 `src/tools/AgentTool/loader.ts` changes

**Remove `'skills'` from `DROPPED_FIELDS`** (line 67-80):

```diff
 const DROPPED_FIELDS = [
-  'skills',
   'hooks',
   'mcpServers',
   ...
 ] as const;
```

**Add to `frontmatterSchema`** (line ~43-62):

```diff
   tools: z.array(z.string()).optional(),
+  skills: z.array(z.string()).optional(),
   model: z.string().min(1).optional(),
```

**Add to `AgentDefinition` interface** (line 17-28):

```diff
 export interface AgentDefinition {
   name: string;
   description: string;
   tools: string[];
+  skills: string[];
   model?: string;
   ...
 }
```

**Set in returned definition** (line ~424-437):

```diff
   return {
     name: parsed.name,
     description: parsed.description,
     tools: parsed.tools ?? [],
+    skills: parsed.skills ?? [],
     model: parsed.model,
     ...
   };
```

### 8.2 `src/tools/AgentTool/spawn.ts` changes

Add skill preload block. Use `runAgent`'s existing `prebuilt.forkContextMessages`
hook (verified at `src/core/query-loop.ts:254-265`) — no new param needed.

```diff
 export async function spawnSubagent<T>(
   def: AgentDefinition,
   prompt: string,
   parentCtx: ToolContext,
   callbacks?: SpawnCallbacks,
   outputSchema?: z.ZodType<T>,
   parentTaskId?: string,
 ) {
   const config = buildAgentConfigFromDefinition(def);
   const childCtx = createChildContext(parentCtx, parentTaskId);

+  // Skill preload: inject declared skills' content as cache-safe
+  // forkContextMessages so they sit between systemPrompt and the user
+  // message, and survive cross-agent cache sharing.
+  const forkContextMessages = await buildSkillPreloadMessages(
+    def.skills,
+    childCtx,
+  );

   return runAgent<T>(
     config,
     prompt,
     childCtx,
     outputSchema,
     callbacks?.onProgress,
+    forkContextMessages.length > 0
+      ? { systemBlocks: [], forkContextMessages }
+      : undefined,
     undefined,
     callbacks?.onEvent,
   );
 }

+async function buildSkillPreloadMessages(
+  skillNames: string[],
+  ctx: ToolContext,
+): Promise<Anthropic.Messages.MessageParam[]> {
+  if (skillNames.length === 0) return [];
+  const allSkills = await getAllSkills(SKILLS_ROOT);
+  const messages: Anthropic.Messages.MessageParam[] = [];
+  for (const name of skillNames) {
+    const skill = allSkills.find(s => s.name === name);
+    if (!skill) {
+      log.warn(`spawn: skill "${name}" declared by agent but not registered`);
+      continue;
+    }
+    const content = await skill.getPromptForCommand('', ctx);
+    messages.push({
+      role: 'user',
+      content: [
+        { type: 'text', text: formatSkillLoadingMetadata(name) },
+        { type: 'text', text: content },
+      ],
+    });
+  }
+  return messages;
+}
```

### 8.3 `src/tools/registry.ts` changes

```diff
+import { skillTool } from './SkillTool/SkillTool';
+
+// Skill primitive — see src/skills/ + src/tools/SkillTool/.
+registry.register(skillTool);
```

After registration, agents may opt into skill access by adding `skill` to their
`AGENT.md` frontmatter `tools:` list.

## 9. Demo skills

Phase 1 ships **two** demo skills, one per non-preload context mode, so
each test path is deterministic (no frontmatter hot-swap during tests):

```
src/skills/
├── _demo-echo-inline/
│   ├── SKILL.md            ← context: inline
│   ├── references/
│   │   └── format.md       ← exercises progressive disclosure
│   └── __tests__/
│       └── _demo-echo-inline.test.ts
└── _demo-echo-fork/
    ├── SKILL.md            ← context: fork, allowed-tools: []
    └── __tests__/
        └── _demo-echo-fork.test.ts
```

Both skills share an identical body (echo args in an `ECHO_START`/`ECHO_END`
block) — the only difference is the `context` frontmatter field. This makes
the test setup cleanest: each test imports the skill it needs and asserts
behavior without touching the other.

The `inline` skill also doubles as the agent-frontmatter-preload subject:
an integration test sets up an agent with `skills: [_demo-echo-inline]`
and asserts the skill content shows up in `forkContextMessages`.

`SKILL.md`:

```yaml
---
name: _demo-echo-skill
description: |
  Echoes back received args wrapped in a structured ECHO_START/ECHO_END
  block. Phase 1 smoke-test skill. Internal only.
context: inline
allowed-tools: []
when-to-use: Only invoked by Phase 1 SkillTool integration tests.
---

# Echo skill (smoke test)

Echo back the args you received, wrapped in this exact format:

```
ECHO_START
args: <args verbatim>
ECHO_END
```

For format details and test fixtures, see [format spec](references/format.md).
```

### 9.1 Test matrix

| # | Path | Verifies |
|---|---|---|
| 1 | `loadSkillsDir(SKILLS_ROOT)` returns both demo skills with parsed frontmatter | discovery + parsing |
| 2 | Frontmatter Zod validation accepts both demos and rejects malformed variants | schema correctness |
| 3 | `spawn(agentWithSkillsFrontmatter: ['_demo-echo-inline'])` injects demo skill into `forkContextMessages` passed to `runAgent` | preload bridge |
| 4 | Agent with `tools: [skill]` calls SkillTool for `_demo-echo-inline` → returned `newMessages` are appended to caller conversation → next turn sees ECHO_START | inline mid-turn |
| 5 | Agent with `tools: [skill]` calls SkillTool for `_demo-echo-fork` → SkillTool returns `status: 'forked'` with extracted result text containing ECHO_START | fork mode |
| 6 | `registerBundledSkill({ name: '_demo-bundled-echo', ... })` then `getAllSkills()` returns it ahead of file skills | bundled registration |
| 7 | FS watcher: edit `_demo-echo-inline/SKILL.md` mid-process, next `getAllSkills` reflects change after debounce | watcher invalidation |
| 8 | Agent without `skill` in `tools:` cannot invoke SkillTool → permission error | permission flow |

## 10. Testing strategy

### 10.1 Unit tests (per-component)

| File | Coverage |
|---|---|
| `src/tools/SkillTool/__tests__/loadSkillsDir.test.ts` | discovery, parse errors, unknown frontmatter pass-through |
| `src/tools/SkillTool/__tests__/SkillTool.test.ts` | three context modes, permission flow, forked context isolation, args substitution |
| `src/tools/SkillTool/__tests__/registry.test.ts` | bundled registration, name-conflict precedence, watcher invalidation |
| `src/tools/AgentTool/__tests__/spawn.test.ts` | skill preload — happy path + missing skill warning |
| `src/skills/_demo-echo-skill/__tests__/_demo-echo-skill.test.ts` | demo skill loads, all three modes execute |

### 10.2 Integration tests

| File | Coverage |
|---|---|
| `src/tools/SkillTool/__tests__/SkillTool.integration.test.ts` | full agent spawn → SkillTool invocation → result |
| `src/workers/processors/__tests__/team-run.integration.test.ts` (existing) | regression: zero behavior change for existing agents (none declare `skills:`) |

### 10.3 Regression

Phase 1 change is invisible to existing flows. The acceptance gate:
- All existing agent tests green (`src/tools/AgentTool/agents/*/__tests__/`)
- All existing worker tests green (`src/workers/**/__tests__/`)
- `pnpm tsc --noEmit` clean

## 11. Risks + mitigations

| Risk | Mitigation |
|---|---|
| `runAgent`'s `prebuilt.forkContextMessages` hook used for skill preload turns out to behave differently than the engine's "initialMessages" idea (e.g., cache-key handling, position relative to systemPrompt) | **Hard verification gate before merging spawn.ts changes**: write a unit test that spawns an agent with one preloaded skill and asserts (a) the skill content appears between systemPrompt and the user message, (b) the systemPrompt cache key is unchanged across two spawns of the same agent. If the test fails, fall back to adding an explicit `initialMessages` param to `runAgent` (~30 LOC additional change to `src/core/query-loop.ts`) |
| Bundled skill side-effect import path (`import '@/skills/_bundled'`) silently no-ops on bundler tree-shake | Add an explicit smoke test that registers a bundled skill in `_bundled/_smoke.ts` and asserts it appears in `getAllSkills()` |
| FS watcher fires on `.swp` / editor temp files, thrashing cache | Filter to `*.md` only (mirror AgentTool's `registry.ts:85`) |
| Inline mid-turn skill injection breaks cache hits because `newMessages` shifts the conversation prefix | Inline injection happens after the systemPrompt + initial fork messages, so caller's prompt prefix is stable; but verify with cache-hit logging on a real run |
| Skill name conflict between bundled and file skills | Phase 1: bundled wins (documented). Future: add a loader warning when conflict detected |
| Skill is invoked from an agent whose tool pool lacks one of `allowed-tools` (fork mode) | Sub-agent fails fast at `resolveAgentTools()` — same fail-closed behavior as agents (`spawn.ts:104`) |

## 12. What Phase 2+ unlocks (informational, NOT in Phase 1)

Phase 2 candidates, in priority order:

1. **Encouraging-reply fix**: extract `judging-reply-opportunity`,
   `drafting-encouraging-replies`, `drafting-data-add-replies`,
   `validate-and-repair-tone` skills from `community-manager`. Update
   `community-manager/AGENT.md` to declare these in `skills:` frontmatter
   and trim the body to the dispatch logic. This is the original problem
   that motivated the brainstorm.
2. **post-writer mirror**: similar extraction for original-post drafting,
   reusing the archetype skills cross-platform.
3. **First real bundled skill**: `inject-product-context` — reads product
   brief from DB and injects as context. Currently every agent that needs
   product context calls `query_product_context` tool, paying a turn.

These are out of scope for Phase 1 and will get their own design + plan.

## 13. Open questions / follow-ups

- `paths:` frontmatter is parsed but not enforced (per §7.3). Decide
  enforcement path in Phase 2 if cross-agent invocation becomes noise.
- `evals/evals.json` format is documented but Phase 1 has no test runner
  for it. Phase 2 should ship a `pnpm skill:eval <name>` runner.
- Skill name conflict policy is "bundled wins"; should it be "fail loud"
  instead? Defer until conflict actually happens.
- Whether to add `effort` (CC engine field, controls thinking-token
  budget) — not in Phase 1; revisit if Phase 2 fork skills want it.

## 14. Estimated work breakdown

| Component | Approx LOC | Effort |
|---|---|---|
| `src/tools/SkillTool/SkillTool.ts` (port + strip) | ~250 | 0.5 day |
| `src/tools/SkillTool/loadSkillsDir.ts` (port + strip) | ~200 | 0.5 day |
| `src/tools/SkillTool/registry.ts` (FS watcher + bundled registry) | ~120 | 0.3 day |
| `src/tools/SkillTool/prompt.ts` (roster description) | ~50 | 0.1 day |
| `src/tools/SkillTool/constants.ts` | ~20 | trivial |
| `src/utils/argumentSubstitution.ts` (copy from engine) | ~40 | trivial |
| `src/utils/forkedAgent.ts` (strip from engine) | ~80 | 0.2 day |
| `src/tools/AgentTool/loader.ts` (skills field) | ~10 | trivial |
| `src/tools/AgentTool/spawn.ts` (preload block) | ~50 | 0.2 day |
| `src/core/query-loop.ts` (verify forkContextMessages support) | ~10 | 0.1 day |
| `src/tools/registry.ts` (register skillTool) | ~5 | trivial |
| `src/skills/_demo-echo-skill/` | ~100 | 0.3 day |
| `src/skills/_bundled/index.ts` (empty barrel) | ~5 | trivial |
| Tests (unit + integration) | ~600 | 1.5 days |
| **Total** | **~1540** | **~4 dev-days** |

Includes test code. Production-only is ~900 LOC; ~700 of that is
strip-ports from `engine/`.
