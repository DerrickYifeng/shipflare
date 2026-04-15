# X Search Guide

## Platform Routing

Use `x_search` with query strings. `source` is the topic context.

## Query Format

Adapt queries for X style — shorter, conversational. X search via Grok understands natural language context.

- Focus on QUESTION-format queries: "how do I", "anyone know", "need help with"
- Target frustration and pain: "struggling with", "can't figure out", "tired of"
- Avoid generic tool/category queries — these attract promoters, not users
- Think about how real indie devs/founders ask for help on X

## Filtering Noise

X search returns a LOT of self-promotion and tool roundup threads. Apply these filters BEFORE scoring:
- **Competitor self-promo**: Tweets announcing/promoting the author's own marketing tool → relevance ≤ 0.2
- **Tool roundup lists** ("Top 10 AI tools", "Here are 60 tools"): The author is a curator, not a potential user → relevance ≤ 0.2
- **Generic AI news** sharing without personal pain: Not a potential user → relevance ≤ 0.1
- Focus on tweets where the author is **asking a question**, **describing a problem**, or **venting frustration** — these are potential users

## Field Mapping

When collecting X results, map fields to the standard format:
- `tweetId` → `id`
- `text` → `title`
- `url` → `url`
- `topic` → `community`
