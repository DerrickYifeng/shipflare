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
   system prompts. The content-batch skill is the reference design: generic agent +
   platform-specific reference docs.

3. **Shared references in `src/references/`**, skill-specific in `src/skills/{name}/references/`.
   If 2+ skills use the same doc, move it to shared. Declare via `shared-references` in SKILL.md.

4. **Tools are namespaced by platform** (`reddit_search`, `x_post`), but agents declare tools
   via SKILL.md `allowed-tools`, not in their system prompt text.

5. **Client instantiation via `createPlatformDeps()`** in `src/lib/platform-deps.ts`.
   Processors should not contain `if (platform === 'x')` client construction blocks.

### New Platform Checklist

When adding a new channel (e.g., LinkedIn):
- [ ] Add entry to `src/lib/platform-config.ts`
- [ ] Create platform tools in `src/tools/` (e.g., `linkedin-search.ts`, `linkedin-post.ts`)
- [ ] Register tools in `src/tools/registry.ts`
- [ ] Add platform case to `generate_queries` strategy map
- [ ] Add case to `createPlatformDeps()` in `src/lib/platform-deps.ts`
- [ ] Create reference docs for relevant skills (`*-search-guide.md`, `*-content-guide.md`, etc.)
- [ ] Update `allowed-tools` in relevant SKILL.md frontmatters
- [ ] NO changes needed to: skill-runner, swarm, query-loop, schemas, or core agent .md files

### Content-Batch Pattern (Reference Design)

The content-batch skill demonstrates the correct pattern for multi-platform skills:
- Generic agent prompt in `src/agents/content.md` (no platform logic)
- Platform-specific rules in `src/skills/content-batch/references/x-content-guide.md`
- Strategy docs shared via `src/references/platforms/x-strategy.md`
- Fan-out by `calendarItems` (platform-agnostic field)
- Caller selects which skill and references to inject

### What NOT to Do

- Don't create parallel platform-specific processors (`reddit-discovery.ts` + `x-discovery.ts`).
  Use one processor with `createPlatformDeps()` routing.
- Don't duplicate reference docs across skills. Use `shared-references`.
- Don't hardcode subreddit/topic lists. Use `platform-config.ts`.
- Don't add platform checks (`if platform === 'x'`) to `skill-runner.ts` or `swarm.ts`.
  Platform awareness belongs in tools, references, and `platform-deps.ts`.
