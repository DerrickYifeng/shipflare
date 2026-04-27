---
name: valid-agent
description: A fully populated agent fixture used to exercise the happy path of the AGENT.md loader.
model: claude-sonnet-4-6
maxTurns: 12
color: blue
tools:
  - Task
  - query_plan_items
  - SendMessage
references:
  - playbook
shared-references:
  - base-guidelines
---

# Valid agent

This agent exists to verify the loader produces the expected shape.

It intentionally mixes block-list frontmatter, a folded description, and per-agent + shared references.
