---
name: generate-interview-questions
description: Exactly 10 customer-interview questions tailored to phase + intent.
context: fork
agent: generate-interview-questions
model: claude-sonnet-4-6
maxTurns: 1
cache-safe: true
output-schema: interviewQuestionsOutputSchema
allowed-tools: []
references:
  - ./references/interview-patterns.md
---

# generate-interview-questions

One LLM call per interview script. Returns exactly 10 primary questions
+ up to 10 follow-up prompts the founder can deploy reactively. The
`intent` input selects the question family (discovery / activation /
retention / win_back / pricing); phase shapes the tone.

## Input

See agent prompt.

## Output

See `interviewQuestionsOutputSchema`.

## When to run

- Foundation phase: 3-5 discovery interviews per week.
- Compound / steady phase: one retention or pricing script per month.
- Win-back on-demand when a user churns out of a paid tier.

Schema requires `questions.length === 10`. Under or over is rejected —
forces the agent to commit to a complete script rather than a
half-finished list.
