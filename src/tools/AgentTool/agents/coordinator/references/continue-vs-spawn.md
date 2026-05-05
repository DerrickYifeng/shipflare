# Continue vs. Spawn — choose by context overlap

When you need a teammate to do work, choose between two paths:

- **Continue**: `SendMessage({to: <existing agentId>, content: ...})` —
  the existing teammate has its conversation context; the new request
  becomes the next user turn for it.
- **Spawn**: `Task({subagent_type, prompt, run_in_background: true})` —
  a fresh teammate context is created.

| Scenario | Choice |
|---|---|
| Research explored the exact files you need to change | ✅ Continue (the worker has these files in context) |
| Research was broad; implementation narrows to a few files | ✅ Spawn fresh (avoid exploration noise polluting context) |
| Fixing a failure / continuing the just-finished work | ✅ Continue (the worker knows what it just tried) |
| Verifying another worker's just-shipped code | ✅ Spawn fresh (verifier should see the code with fresh eyes) |
| First implementation went down the wrong path | ✅ Spawn fresh (anchoring on the wrong-path context taints the retry) |
| Completely unrelated new task | ✅ Spawn fresh (no context to reuse) |

## Cost framing

- Continue is cheap: the existing context is already loaded; you're just
  adding a turn.
- Spawn pays a fresh-context tax: the new teammate has to read the
  AGENT.md, any preloaded skills, and figure out what to do from scratch.

But Continue has a context-pollution cost: the existing conversation may
contain irrelevant exploration that distracts the LLM. **When the prior
exploration is REUSE-EXCEPTION-WORTHY, prefer Continue. Otherwise prefer
Spawn fresh.**
