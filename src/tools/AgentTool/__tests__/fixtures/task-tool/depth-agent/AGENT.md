---
name: depth-agent
description: Fixture agent that re-invokes Task to exercise the spawn-depth limit. USE in tests only.
model: claude-sonnet-4-6
maxTurns: 5
tools:
  - Task
---

# Depth agent

Always delegates further via Task. Used to walk the spawn chain up to the
MAX_SPAWN_DEPTH limit in tests.
