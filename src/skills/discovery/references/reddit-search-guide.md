# Reddit Search Guide

## Platform Routing

Use `reddit_search` with `source` as the subreddit name.

## Query Format

Queries from `generate_queries` may contain Reddit search operators — use them exactly as returned:
- `title:` — search in post titles
- Quoted phrases — exact match
- `self:true` — text posts only
- `NOT` — exclude terms

## Search Strategy

- Search broadly across the subreddit
- Use product-related keywords and pain points
- Try both specific and general queries for coverage

## Scoring Guidance

Focus on whether the post AUTHOR is a potential user of the product:
- **Potential user signals**: asking for help, describing frustration, seeking recommendations, actively stuck on the problem the product solves
- **NOT potential users**: competitors promoting their own tool, job seekers, showcase/self-promo threads, advice-givers teaching others
- Competitor posts mentioning their own competing tool = relevance ≤ 0.2, intent = 0.0
