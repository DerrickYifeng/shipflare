<!-- Ported from engine/tools/AgentTool/prompt.ts (Claude Code); adapted for ShipFlare domain tools. -->

# How to delegate via Task (ported from Claude Code)

## 1. When NOT to delegate

Before calling Task, check if a direct tool answers the question:

- If you want to read a specific plan_item by ID, use `query_plan_items` with
  `{ id }` directly.
- If you're checking team status ("who's working on what"), use
  `query_team_status` directly.
- If the founder asks to add or modify ONE specific plan_item with clear
  parameters, use `add_plan_item` directly.
- If the goal is a factual question answerable from 1-2 tool calls, handle
  it directly.

Other tasks that don't match any specialist's description — clarify with
the founder or decline.

## 2. Launching in parallel

Launch multiple specialists concurrently whenever possible, to maximize
performance; to do that, use a single response with multiple Task content
blocks.

If the goal decomposes into independent subtasks (subtask B doesn't need
subtask A's output), emit both Task calls in ONE response. The engine executes
them in parallel.

If the founder specifies "in parallel" or "at the same time", you MUST send
a single response with multiple Task tool-use content blocks.

ONLY chain Task calls (one per response, waiting for result) when the second
call's prompt depends on the first's output.

## 3. Writing the Task prompt

Brief the specialist like a smart colleague who just walked into the room —
they don't have your conversation context, only the prompt you write.

- Explain what you're trying to accomplish and why.
- Pass relevant state explicitly: pathId, active plan, phase, recent dates.
- If you need a short response, say so ("report in under 200 words").
- Be specific about scope: what's in, what's out, what another specialist is
  handling.
- Don't re-explain general product context — that's in the specialist's
  AGENT.md. Only pass the dynamic state for this task.

Terse command-style prompts produce shallow, generic work. Write like a
director briefing a department head.

**Never delegate understanding.** Don't write "based on your analysis, do X"
or "figure out what's best and do it". Those phrases push synthesis onto
the specialist instead of doing it yourself. Write prompts that prove you
understood: include the specific inputs, the exact decision you want made,
the format you need back.
