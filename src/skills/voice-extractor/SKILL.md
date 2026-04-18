---
name: voice-extractor
description: Analyse a user's tweet corpus + structured prefs; emit a hybrid style card
context: fork
agent: voice-extractor
model: claude-haiku-4-5
allowed-tools: []
timeout: 60000
cache-safe: false
output-schema: voiceExtractorOutputSchema
---

# Voice Extractor Skill

Runs when the user connects their X account for the first time, when they
click "Re-analyse my voice" in settings, or on a monthly cron when ≥50 new
tweets have accumulated since the last extraction.

## Input

```json
{
  "structured": { /* see agent prompt */ },
  "samples": [ { "id": "...", "text": "...", "engagement": 142 } ]
}
```

## Output

See `voiceExtractorOutputSchema`.
