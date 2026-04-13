---
name: discovery
description: Fan-out Reddit thread discovery across subreddits for a product
context: fork
agent: discovery
model: claude-haiku-4-5-20251001
allowed-tools:
  - generate_queries
  - reddit_search
  - score_threads
fan-out: subreddits
max-concurrency: 5
timeout: 120000
cache-safe: true
---

# Discovery Skill

Discovers Reddit threads where a product can be naturally mentioned.

## Workflow

For each subreddit in the input, fork a discovery agent that:
1. Generates consumer-voice search queries using product context
2. Searches the subreddit for matching threads
3. Assesses relevance and intent for each thread
4. Scores threads with weighted multi-dimensional scoring

## Fan-Out Strategy

Each subreddit gets its own agent instance. All agents share identical
system prompt and tools for Anthropic prompt cache hits (~90% cost
reduction on agents 2-N).

## Input

```json
{
  "product": { "name": "", "description": "", "keywords": [], "valueProp": "" },
  "subreddits": ["SideProject", "startups", "webdev"]
}
```

## Output

Aggregated, deduplicated threads with weighted scores. Threads from
all subreddits merged, deduplicated by ID, sorted by score descending.
