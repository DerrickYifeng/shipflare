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

X search returns mostly promotional and advisory content. Apply these filters BEFORE scoring:
- **Competitor self-promo**: Author promoting their own tool → relevance ≤ 0.2, intent = 0.0
- **Tool roundup lists** ("Top 10 tools", "Here are 60 tools"): Curator, not user → relevance ≤ 0.2
- **Teaching/coaching threads** ("Here's how to...", "My framework..."): Giving advice, not seeking → intent ≤ 0.2
- **Success stories** ("How I got X users", "Here's what worked"): Sharing, not seeking → intent ≤ 0.2
- **Generic news/opinion** without personal pain: Not a potential user → relevance ≤ 0.1

Only score HIGH for tweets where the author is:
- **Asking a question** ("how do I...?", "anyone know...?")
- **Describing their OWN struggle** ("I can't figure out...", "been trying to...")
- **Requesting recommendations** ("what tools do you use for...?")

## Field Mapping

When collecting X results, map fields to the standard format:
- `tweetId` → `id`
- `text` → `title`
- `url` → `url`
- `topic` → `community`
