---
name: generate-launch-asset-brief
description: Generate a text brief for one launch asset (gallery image, 30s video, OG image, demo GIF).
context: fork
agent: generate-launch-asset-brief
model: claude-sonnet-4-6
maxTurns: 1
cache-safe: true
output-schema: launchAssetBriefOutputSchema
allowed-tools: []
references:
  - ./references/asset-types.md
---

# generate-launch-asset-brief

Text-only skill — it does not render anything. Produces a brief that a
designer or video editor can execute in under 4 hours. Each brief names
the asset type, a shot list, the mandatory inclusions / banned motifs, and
optional reference inspirations (public launches only).

## Input

See agent prompt. `assetType` scopes the brief shape.

## Output

See `launchAssetBriefOutputSchema`.

## Why a separate brief skill

AI image generation is still awkward on specific product UIs and the
public LP / PH algorithm punishes obvious AI art. Founders who go pro
ship sharper; founders who don't go pro buy a brief and commission the
asset. Either path starts with a good brief.

The planner schedules one brief per asset type in `momentum` phase so the
designer has 3-7 days to execute before launch.
