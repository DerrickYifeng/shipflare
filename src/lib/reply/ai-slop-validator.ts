export type AiSlopViolation =
  | 'em_dash_overuse'
  | 'binary_not_x_its_y'
  | 'preamble_opener'
  | 'banned_vocabulary'
  | 'triple_grouping'
  | 'negation_cadence'
  | 'engagement_bait_filler';

export interface AiSlopResult {
  pass: boolean;
  violations: AiSlopViolation[];
}

const PREAMBLE_PATTERNS: RegExp[] = [
  /^\s*great (?:post|point|question|take|thread)\b/i,
  /^\s*(?:interesting|fascinating) (?:take|point|perspective)\b/i,
  /^\s*as (?:a|someone who)\b/i,
  /^\s*i (?:noticed|saw) (?:you|that you)\b/i,
  /^\s*have you considered\b/i,
  /^\s*absolutely[\s,.!]/i,
  /^\s*certainly[\s,.!]/i,
  /^\s*love this\b/i,
];

const ENGAGEMENT_BAIT_PATTERNS: RegExp[] = [
  /^\s*this\.?\s*$/i,
  /^\s*100\s*%\.?\s*$/i,
  /^\s*so true[!.]*\s*$/i,
  /^\s*bookmarked\b/i,
  /^\s*\+1\s*$/,
  /^\s*this really resonates\b/i,
];

const BANNED_VOCAB: string[] = [
  'delve', 'leverage', 'utilize', 'robust', 'crucial', 'pivotal',
  'demystify', 'landscape', 'ecosystem', 'journey', 'seamless',
  'navigate', 'compelling',
];

function countEmDashes(text: string): number {
  return (text.match(/\u2014|---| -- /g) ?? []).length;
}

function hasBinaryNotXItsY(text: string): boolean {
  return /\b(?:it['\u2019]s|this is)\s+not(?:\s+just)?\s+[\w\s]{1,40}[,.\u2014\-]+\s*(?:it['\u2019]s|this is|[\u2014\-])\s*[\w\s]{1,40}/i.test(text);
}

function hasTripleGrouping(text: string): boolean {
  return /\b(\w{3,}),\s+(\w{3,}),\s+(?:and\s+)?(\w{3,})\b/.test(text);
}

function hasNegationCadence(text: string): boolean {
  return /\bno\s+\w+[.!]\s+no\s+\w+[.!]/i.test(text);
}

function hasBannedVocab(text: string): boolean {
  const lower = text.toLowerCase();
  return BANNED_VOCAB.some((w) => new RegExp(`\\b${w}\\b`).test(lower));
}

export function validateAiSlop(text: string): AiSlopResult {
  const violations: AiSlopViolation[] = [];

  if (countEmDashes(text) >= 2) violations.push('em_dash_overuse');
  if (hasBinaryNotXItsY(text)) violations.push('binary_not_x_its_y');
  if (PREAMBLE_PATTERNS.some((r) => r.test(text))) violations.push('preamble_opener');
  if (hasBannedVocab(text)) violations.push('banned_vocabulary');
  if (hasTripleGrouping(text)) violations.push('triple_grouping');
  if (hasNegationCadence(text)) violations.push('negation_cadence');
  if (ENGAGEMENT_BAIT_PATTERNS.some((r) => r.test(text))) violations.push('engagement_bait_filler');

  return { pass: violations.length === 0, violations };
}
