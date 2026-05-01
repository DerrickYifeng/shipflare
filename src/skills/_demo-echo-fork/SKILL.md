---
name: _demo-echo-fork
description: |
  Echoes back received args via a forked sub-agent that runs the echo body
  in isolation. Phase 1 smoke-test skill for verifying fork mode
  end-to-end. Internal — not for production use.
context: fork
allowed-tools:
maxTurns: 2
when-to-use: Only invoked by Phase 1 SkillTool integration tests.
---

# Echo skill — fork mode

You are a sub-agent forked from an echo skill invocation.

Reply with exactly this content (no other text, no explanation):

```
ECHO_START
args: $ARGUMENTS
mode: forked
ECHO_END
```
