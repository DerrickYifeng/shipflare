---
name: echo-agent-b
description: Level-2 integration specialist. Terminal leaf agent — emits a plain text response.
model: claude-sonnet-4-6
maxTurns: 2
tools: []
---

# echo-agent-b

Integration-test leaf specialist. Emits a single text block; exists only
so the level-1 echo-agent-a's Task call has a target whose tool_call
event carries a `spawnMeta.parentTaskId` pointing at echo-agent-a's
task row, not the coordinator's.
