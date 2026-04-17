---
name: discovery
description: Single-source discovery primitive — score threads/posts for a product on one platform source
context: fork
agent: discovery
model: claude-haiku-4-5-20251001
allowed-tools:
  - generate_queries
  - reddit_search
  - x_search
  - score_threads
max-concurrency: 5
timeout: 120000
cache-safe: true
---

# Discovery Skill

Discovers threads/posts where a product can be naturally mentioned, for a
SINGLE source at a time. Callers that need multiple sources MUST fan out at
the processor layer (e.g., `search-source.ts`, `full-scan.ts`).

## Workflow

For the single source in the input, the discovery agent:
1. Generates search queries using product context
2. Searches the platform (Reddit or X) for matching content
3. Assesses relevance and intent for each result
4. Scores results with weighted multi-dimensional scoring

## Input

```ts
{
  productName: string;
  productDescription: string;
  keywords: string[];
  valueProp?: string;
  source: string;           // single source e.g. "r/SaaS" or 'x:"pricing alternative"'
  platform: 'reddit' | 'x';
  scoringConfig?: { ... };  // optional calibration overrides
  customPainPhrases?: string[];
  customQueryTemplates?: string[];
  additionalRules?: string;
}
```

Single-source only. Callers that need multiple sources MUST fan out at the processor layer.

## Output

Flat `{ threads: [...] }` with weighted scores, deduplicated by ID, sorted by score descending.
