---
name: echo-agent
description: Integration-test specialist. Returns whatever the coordinator asks it to echo, via StructuredOutput.
model: claude-sonnet-4-6
maxTurns: 2
tools: []
---

# echo-agent

A stub specialist used by `team-run.integration.test.ts`. The test mocks the
Anthropic API to script exactly one turn of this agent: it MUST call
StructuredOutput with `{ echoed: <value> }` on its first response.
