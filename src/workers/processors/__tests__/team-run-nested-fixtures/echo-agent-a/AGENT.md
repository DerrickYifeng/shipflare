---
name: echo-agent-a
description: Level-1 integration specialist. Spawns echo-agent-b via Task and returns the aggregated result.
role: lead
model: claude-sonnet-4-6
maxTurns: 4
tools:
  - Task
---

<!-- role: lead is required because this fixture spawns a sub-Task. The
     production architecture only has one lead per team (the coordinator);
     this fixture tests the four-layer filter + event propagation paths,
     not the production invariant. -->


# echo-agent-a

Integration-test level-1 specialist. Receives a Task call from
`coordinator-nested` and spawns `echo-agent-b` as its own Task; the
resulting tool_start / tool_done events must carry a `spawnMeta` tag
pointing at echo-agent-a's `team_tasks.id` so the activity log can build
the full delegation tree.
