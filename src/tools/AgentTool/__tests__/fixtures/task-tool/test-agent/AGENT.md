---
name: test-agent
description: A minimal agent fixture used by the Task tool tests. USE for greeting-style delegations in unit tests only.
model: claude-sonnet-4-6
maxTurns: 3
tools:
  - reddit_search
  - web_search
---

# Test agent

A stub specialist used to exercise the Task tool's spawn + allowlist path.
The body content is intentionally short because the tests mock `runAgent` and
never actually invoke this agent against a model.
