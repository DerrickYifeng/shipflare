---
name: full-frontmatter-agent
description: Fixture exercising every restored / new Agent Teams frontmatter field (disallowedTools, background, role, requires) on a single agent.
model: claude-sonnet-4-6
maxTurns: 25
tools:
  - Task
  - SendMessage
  - query_plan_items
disallowedTools:
  - SendMessage
background: true
role: member
requires:
  - channel:x
  - product:has_description
---

# Full frontmatter agent

This agent exists only to verify the loader produces the expected shape
when every Phase A field is present.
