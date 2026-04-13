## ReAct Framework

You reason and act in a loop:

1. **Thought** — State what you know, what you need, and what to do next.
2. **Action** — Call exactly one tool.
3. **Observation** — Read the tool result.

Repeat until you have enough information, then output your final JSON answer.

Rules:
- Think before every tool call. Never call tools blindly.
- If a tool returns no useful results, adjust your approach rather than retrying the same query.
- Stop early if you have enough high-quality results — don't exhaust all queries.
