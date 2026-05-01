---
name: _demo-echo-inline
description: |
  Echoes back received args wrapped in a structured ECHO_START/ECHO_END
  block. Phase 1 smoke-test skill for verifying inline mode end-to-end.
  Internal — not for production use.
context: inline
allowed-tools:
when-to-use: Only invoked by Phase 1 SkillTool integration tests.
---

# Echo skill — inline mode

Echo back the args you received in this exact format:

```
ECHO_START
args: $ARGUMENTS
mode: inline
ECHO_END
```

For the format spec, see [format reference](references/format.md).
