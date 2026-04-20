// Heuristic category inference from extracted keywords + description.
// Runs once when Stage 3 first reveals the category field so the default
// matches the user's product instead of defaulting everyone to `dev_tool`.
// Falls back to `other` when nothing matches. Non-blocking — user can
// always override via the picker.

import type { ProductCategory } from './OnboardingFlow';

interface InferSignals {
  keywords: readonly string[];
  description: string;
  name: string;
}

type CategoryCue = readonly [ProductCategory, readonly RegExp[]];

const CUES: readonly CategoryCue[] = [
  [
    'dev_tool',
    [
      /\bdev(?:eloper)? tool(?:s)?\b/i,
      /\bSDK\b/,
      /\bCLI\b/,
      /\bAPI\b/,
      /\bopen[- ]source\b/i,
      /\blinter\b/i,
      /\bframework\b/i,
      /\bIDE\b/,
    ],
  ],
  [
    'saas',
    [
      /\bSaaS\b/,
      /\bB2B\b/,
      /\benterprise\b/i,
      /\bdashboard\b/i,
      /\banalytics\b/i,
      /\bCRM\b/,
    ],
  ],
  [
    'ai_app',
    [
      /\bLLM\b/,
      /\bAI agent\b/i,
      /\bchat(?:bot|gpt)\b/i,
      /\bgenerative ai\b/i,
      /\bRAG\b/,
      /\bvector db\b/i,
    ],
  ],
  [
    'creator_tool',
    [
      /\bcreator\b/i,
      /\bnewsletter\b/i,
      /\bpodcast\b/i,
      /\bvideo edit\b/i,
      /\bstream(?:ing|er)\b/i,
      /\bcontent\b/i,
    ],
  ],
  [
    'agency',
    [
      /\bagency\b/i,
      /\bconsult(?:ing|ancy)\b/i,
      /\bservices?\b/i,
      /\bwhite[- ]label\b/i,
    ],
  ],
  [
    'consumer',
    [
      /\bconsumer\b/i,
      /\bmobile app\b/i,
      /\bB2C\b/,
      /\bmarketplace\b/i,
      /\bdating\b/i,
      /\bsocial\b/i,
      /\bfitness\b/i,
      /\bwellness\b/i,
    ],
  ],
];

export function inferCategory(signals: InferSignals): ProductCategory {
  const hay = [
    signals.name,
    signals.description,
    ...signals.keywords,
  ]
    .filter(Boolean)
    .join(' ');
  if (!hay.trim()) return 'other';
  for (const [category, patterns] of CUES) {
    if (patterns.some((p) => p.test(hay))) return category;
  }
  return 'other';
}
