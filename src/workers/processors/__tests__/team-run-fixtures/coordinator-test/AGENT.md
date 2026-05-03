---
name: coordinator-test
description: Integration-test coordinator. Spawns echo-agent once and emits a terminal StructuredOutput.
role: lead
model: claude-sonnet-4-6
maxTurns: 6
tools:
  - Task
  - SendMessage
---

# coordinator-test

A minimal coordinator stub used by `team-run.integration.test.ts`. The real
coordinator AGENT.md lands in Phase B — this stand-in only needs the right
tool allowlist so the integration test can assert the expected message
sequence when runAgent is driven by a mocked Anthropic API.
