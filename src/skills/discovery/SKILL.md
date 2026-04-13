---
name: discovery
description: Fan-out multi-platform discovery across sources for a product
context: fork
agent: discovery
model: claude-haiku-4-5-20251001
allowed-tools:
  - generate_queries
  - reddit_search
  - x_search
  - score_threads
fan-out: sources
max-concurrency: 5
timeout: 120000
cache-safe: true
---

# Discovery Skill

Discovers threads/posts where a product can be naturally mentioned.
Supports multiple platforms (Reddit, X) via the `platform` input field.

## Workflow

For each source in the input, fork a discovery agent that:
1. Generates search queries using product context
2. Searches the platform (Reddit or X) for matching content
3. Assesses relevance and intent for each result
4. Scores results with weighted multi-dimensional scoring

## Fan-Out Strategy

Each source gets its own agent instance. All agents share identical
system prompt and tools for Anthropic prompt cache hits (~90% cost
reduction on agents 2-N).

The caller must pass `platform` alongside `sources`. All sources in
one skill invocation must be the same platform (never mix Reddit
subreddits and X topics in the same fan-out batch).

## Input

```json
{
  "product": { "name": "", "description": "", "keywords": [], "valueProp": "" },
  "sources": ["SideProject", "startups", "webdev"],
  "platform": "reddit"
}
```

## Output

Aggregated, deduplicated results with weighted scores, merged across
all sources, deduplicated by ID, sorted by score descending.
