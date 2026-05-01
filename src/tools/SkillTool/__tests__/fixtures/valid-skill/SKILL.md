---
name: valid-skill
description: A fully populated valid skill fixture for tests.
context: inline
allowed-tools:
  - validate_draft
  - draft_reply
when-to-use: Only invoked from tests.
argument-hint: <input>
---

# Valid skill body

Echo back: $ARGUMENTS

For details see [format](references/format.md).
