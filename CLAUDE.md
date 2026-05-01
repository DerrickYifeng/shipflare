# ShipFlare

## Skill routing

When the user's request matches an available skill, ALWAYS invoke it using the Skill
tool as your FIRST action. Do NOT answer directly, do NOT use other tools first.
The skill has specialized workflows that produce better results than ad-hoc answers.

Key routing rules:
- Product ideas, "is this worth building", brainstorming → invoke office-hours
- Bugs, errors, "why is this broken", 500 errors → invoke investigate
- Ship, deploy, push, create PR → invoke ship
- QA, test the site, find bugs → invoke qa
- Code review, check my diff → invoke review
- Update docs after shipping → invoke document-release
- Weekly retro → invoke retro
- Design system, brand → invoke design-consultation
- Visual audit, design polish → invoke design-review
- Architecture review → invoke plan-eng-review
- Save progress, checkpoint, resume → invoke checkpoint
- Code quality, health check → invoke health

## Architecture Rules

### Platform-Agnostic Design

1. **No hardcoded platform defaults in processors or routes.**
   Import from `src/lib/platform-config.ts`. Adding a new platform = one entry there.

2. **Reference injection over agent hardcoding.**
   Platform-specific behavior belongs in skill `references/` files, not hardcoded in agent .md
   system prompts. The `draft-single-post` skill is the reference design: generic
   drafting prompt in SKILL.md, platform-specific rules in
   `references/x-content-guide.md` (and one-per-platform as we add them).

3. **Shared references in `src/references/`**, skill-specific in `src/skills/{name}/references/`.
   If 2+ skills use the same doc, move it to shared. Declare via `shared-references` in SKILL.md.

4. **Tools are namespaced by platform** (`reddit_search`, `x_post`), but agents declare tools
   via SKILL.md `allowed-tools`, not in their system prompt text.

5. **Client instantiation via the three sanctioned helpers** in `src/lib/platform-deps.ts`:
   - `createPlatformDeps(platform, userId)` — look up channel by userId, return deps Record
     for `runSkill({ deps })` in workers (discovery, content, posting, etc.).
   - `createClientFromChannel(platform, channel)` — wrap an already-loaded channel row
     into a client. Use this when the job carries `channelId` (e.g. `posting.ts`).
   - `createPublicPlatformDeps(platforms?)` — anonymous / read-only deps for public endpoints
     (`/api/scan`, CLI scripts). Respects `supportsAnonymousRead` + `envGuard` on each config.

   Processors and routes MUST NOT call `XClient.fromChannel` / `RedditClient.fromChannel`
   / `RedditClient.appOnly()` / `new XAIClient()` directly — route through these helpers so
   adding a new platform is one entry in `platform-deps.ts`, not a search-and-replace.

6. **Derive platform-shaped values from `PLATFORMS[id]`.** Use `displayName` for UI copy,
   `sourcePrefix` for labels (`r/`), `buildContentUrl()` for share links,
   `externalIdPattern` (legacy) only when a record lacks an explicit `platform` column —
   prefer joining `threads.platform` / `posts.platform`. Literal `'reddit'` / `'x'` strings
   in processors, routes, and pipelines should reference `PLATFORMS.reddit.id` /
   `PLATFORMS.x.id` so grep-and-replace during rename works and typos surface at compile time.

### New Platform Checklist

When adding a new channel (e.g., LinkedIn):
- [ ] Add entry to `src/lib/platform-config.ts` (including `buildContentUrl`, `supportsAnonymousRead`, etc.)
- [ ] Create platform tools in `src/tools/` (e.g., `linkedin-search.ts`, `linkedin-post.ts`)
- [ ] Register tools in `src/tools/registry.ts`
- [ ] Add platform case to `generate_queries` strategy map
- [ ] Add cases to `createPlatformDeps()`, `createClientFromChannel()`, and
      `createPublicPlatformDeps()` in `src/lib/platform-deps.ts`
- [ ] Create reference docs for relevant skills (`*-search-guide.md`, `*-content-guide.md`, etc.)
- [ ] If the skill fans out across platforms, add the new id to the `channels`
      array in its `src/skills/_catalog.ts` entry so the tactical planner
      selects it for plan items with `channel: '<new>'`.
- [ ] Update `allowed-tools` in relevant SKILL.md frontmatters
- [ ] NO changes needed to: skill-runner, swarm, query-loop, schemas, core agent .md files,
      `full-scan.ts`, `discovery.ts`, `posting.ts`, or `/api/automation/run`

### Skill Pattern (Reference Design)

v3 uses atomic skills — one skill per concrete action (draft one post,
draft one reply, judge one opportunity, etc.). `src/skills/_catalog.ts` is
the source of truth for what ships; each entry declares `supportedKinds`
and optional `channels` so the tactical planner can pick the right tool.

The shipped content-drafting skills are the reference design for adding
new channels:
- `src/skills/draft-single-post/SKILL.md` — generic post-drafting prompt
- `src/skills/draft-single-post/references/x-content-guide.md` —
  X-specific length/tone rules
- `src/skills/draft-single-reply/SKILL.md` + the matching reference
- `src/references/platforms/x-strategy.md` — strategy doc shared across
  skills via `shared-references` in SKILL.md frontmatter

The planning skills (`strategic-planner`, `tactical-planner`) are
single-pass and don't fan out by platform — they receive `channels: []`
in their input and emit a plan whose items each carry a `channel` field
that the caller routes to the right draft-* skill.

Caller (the plan-execute worker) selects which skill to invoke based on
`planItems.skillName` + `planItems.channel`, and which references to
inject. No central "content-batch" orchestrator — each plan_item runs
one atomic skill.

### What NOT to Do

- Don't create parallel platform-specific processors (`reddit-discovery.ts` + `x-discovery.ts`).
  Use one processor with `createPlatformDeps()` routing.
- Don't duplicate reference docs across skills. Use `shared-references`.
- Don't hardcode subreddit/topic lists. Use `platform-config.ts`.
- Don't add platform checks (`if platform === 'x'`) to `skill-runner.ts` or `swarm.ts`.
  Platform awareness belongs in tools, references, and `platform-deps.ts`.
- Don't sniff platform from `externalId` shape (e.g. `/^\d+$/.test(externalId)`).
  `posts.platform` and `threads.platform` are NOT NULL — filter / join on them instead.
  The `PlatformConfig.externalIdPattern` field only exists for legacy records that predate
  the `platform` column; new code must not depend on it.

## Skill Primitive

ShipFlare's multi-agent system has three primitives: **Tool**, **Agent**, **Skill**.
Skills live under `src/skills/<name>/SKILL.md`. The Skill primitive was restored in
Phase 1 of the architecture refactor (see
`docs/superpowers/specs/2026-04-30-skill-primitive-restoration-design.md`).

### Adding a new markdown skill

1. Create `src/skills/<gerund-name>/SKILL.md` (gerund preferred, e.g.
   `drafting-encouraging-replies`).
2. Required frontmatter: `name`, `description`. Optional: `context`
   (`inline` | `fork`), `allowed-tools`, `model`, `maxTurns`,
   `when-to-use`, `argument-hint`, `paths`. **YAML parser note:** the
   frontmatter parser does NOT accept inline `[]` empty arrays — write
   `allowed-tools:` (empty value) rather than `allowed-tools: []`.
3. Body uses `$ARGUMENTS` or `$0` / `$1` for arg substitution. Long
   reference content goes under `references/<name>.md` and is linked
   from the body — Claude reads them progressively, on demand.
4. Add a per-skill `__tests__/<name>.test.ts` mirroring
   `src/skills/_demo-echo-inline/__tests__/_demo-echo-inline.test.ts`.

### Adding a new bundled (TS) skill

Programmatic skills live in `src/skills/_bundled/<name>.ts` and call
`registerBundledSkill({ ... })` at module load. The `src/skills/_bundled/index.ts`
barrel must `import './<name>'` so the side-effect runs.

### Letting an agent invoke skills

Add `skill` to the agent's `AGENT.md` `tools:` list. Optionally declare
`skills: [name1, name2]` to preload specific skills' content into the
agent's initial conversation (useful for agents that always need the
same playbook).

## Security TODO

Tracking pending security hardening beyond what `feat/security-hardening` already shipped.

- **`accounts.access_token` / `accounts.refresh_token` encryption — DONE (approach a).**
  The `accounts` table (Auth.js Drizzle adapter, `src/lib/db/schema/users.ts`) stores
  GitHub OAuth tokens envelope-encrypted via the wrapped DrizzleAdapter in
  `src/lib/auth/index.ts`. Encrypt/decrypt helpers live in
  `src/lib/auth/account-encryption.ts`; reads outside the adapter use
  `maybeDecrypt` (via `getGitHubToken`) so legacy plaintext rows keep working
  until backfilled by `scripts/encrypt-account-tokens.ts --commit`. Run that
  script once per environment after deploy. `DELETE /api/account` also now
  calls GitHub's `DELETE /applications/{client_id}/grant` before DB cascade so
  re-signing-in after deletion re-prompts consent instead of silently relinking.
- **Only the three helpers in `src/lib/platform-deps.ts` (`createPlatformDeps`,
  `createClientFromChannel`, `createPublicPlatformDeps`) plus `RedditClient.fromChannel`
  / `XClient.fromChannel` / `RedditClient.appOnly` are allowed to read
  `channels.oauth_token_encrypted`.** Every other `select().from(channels)` in
  `src/app/api/**` and `src/workers/**` MUST use an explicit projection
  (`select({ id, userId, platform, username, ... })`) and omit token columns.
  Enforced by audit Theme 4 item 3. `createPublicPlatformDeps` is the exception that
  proves the rule: it never touches the `channels` table because it runs before any
  user has connected a channel.
