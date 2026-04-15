---
name: full-scan
description: End-to-end scan — scrape URL, discover communities, find threads, deep-analyze top hits
context: fork
agent: discovery
allowed-tools:
  - scrape_url
compose:
  - community-discovery
  - thread-discovery
  - deep-analysis
timeout: 180000
---

# Full Scan Skill

Orchestrates the complete discovery pipeline: URL scrape, community
discovery, thread discovery, and deep analysis of top candidates.

## Pipeline

```
scrape_url(productUrl)
  → community-discovery(product)
    → thread-discovery(product, communities)
      → deep-analysis(topThreads)
```

## Workflow

1. **Scrape**: Extract product metadata from the provided URL
2. **Community Discovery**: Find communities where target users congregate
3. **Thread Discovery**: Fan-out search across discovered communities
4. **Deep Analysis**: Deep-dive top-scoring threads for engagement decisions

## Input

```json
{
  "url": "https://yourproduct.com"
}
```

## Output

Complete scan results: product metadata, discovered communities,
scored threads, and engagement recommendations for top hits.

## Notes

This skill uses the `compose` directive to chain sub-skills.
The compose feature requires skill-runner support for sequential
skill composition (planned for future implementation).
