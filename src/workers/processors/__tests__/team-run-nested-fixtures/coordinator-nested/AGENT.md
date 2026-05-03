---
name: coordinator-nested
description: Nested-spawn integration coordinator. Spawns echo-agent-a, which spawns echo-agent-b; used to assert onEvent propagation with parentTaskId tagging across 2 levels.
role: lead
model: claude-sonnet-4-6
maxTurns: 8
tools:
  - Task
  - SendMessage
---

# coordinator-nested

Integration-test coordinator that drives a 2-level Task chain. Used by
`team-run.integration.test.ts` to assert nested subagent tool_calls
propagate into the parent team_run's team_messages with the correct
`metadata.parentTaskId` and `fromMemberId` attribution.
