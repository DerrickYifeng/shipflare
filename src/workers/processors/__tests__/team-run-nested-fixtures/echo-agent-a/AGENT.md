---
name: echo-agent-a
description: Level-1 integration specialist. Spawns echo-agent-b via Task and returns the aggregated result.
model: claude-sonnet-4-6
maxTurns: 4
tools:
  - Task
---

# echo-agent-a

Integration-test level-1 specialist. Receives a Task call from
`coordinator-nested` and spawns `echo-agent-b` as its own Task; the
resulting tool_start / tool_done events must carry a `spawnMeta` tag
pointing at echo-agent-a's `team_tasks.id` so the activity log can build
the full delegation tree.
