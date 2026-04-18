export interface AnchorTokenResult {
  pass: boolean;
  anchors: string[];
}

const TIMESTAMP_PHRASES: RegExp[] = [
  /\blast (?:week|month|year|night|quarter)\b/i,
  /\b(?:yesterday|today|tonight)\b/i,
  /\b(?:month|week|day|year)\s+\d+\b/i,
  /\b\d{4}(?:-\d{2}){0,2}\b/,
  /\b(?:yesterday|this morning|earlier today)\b/i,
];

const URL_PATTERN = /\bhttps?:\/\/\S+/i;
const NUMBER_PATTERN = /\$?\d+(?:[.,]\d+)?[%mk]?\b/i;

export function validateAnchorToken(text: string): AnchorTokenResult {
  const anchors: string[] = [];

  // Numbers: plain digits, currency, percentages, shorthand (10k, 20%)
  const numberMatch = text.match(NUMBER_PATTERN);
  if (numberMatch) anchors.push(numberMatch[0]);

  // URLs
  const urlMatch = text.match(URL_PATTERN);
  if (urlMatch) anchors.push(urlMatch[0]);

  // Timestamp phrases
  if (TIMESTAMP_PHRASES.some((r) => r.test(text))) {
    anchors.push('timestamp_phrase');
  }

  // Proper nouns: capitalized words that appear mid-sentence (not sentence-initial)
  const sentences = text.split(/(?<=[.!?])\s+/);
  for (const sentence of sentences) {
    const words = sentence.split(/\s+/);
    // Skip index 0 — sentence-initial capital is not a signal
    for (let i = 1; i < words.length; i++) {
      const word = words[i].replace(/[^\w]/g, '');
      if (/^[A-Z][a-zA-Z0-9]{2,}$/.test(word)) {
        anchors.push(word);
      }
    }
    // camelCase tokens anywhere in the sentence (e.g. photoAI, levelsio-style with digits)
    for (const word of words) {
      const clean = word.replace(/[^\w]/g, '');
      if (/^[a-z]+[A-Z]/.test(clean)) anchors.push(clean);
    }
  }

  // Tokens like "levelsio", "photoAI" — alpha+digit combos
  const embeddedDigits = text.match(/\b[a-z]+\d+[a-z]*\b/gi);
  if (embeddedDigits) anchors.push(...embeddedDigits);

  // Brand/tool names preceded by a connector preposition (e.g. "with postgres", "+ drizzle")
  const COMMON_WORDS = new Set([
    'this', 'that', 'love', 'great', 'agreed', 'same', 'true', 'yes', 'no', 'maybe',
    'ok', 'huge', 'big', 'massive', 'they', 'them', 'their', 'there', 'been', 'where',
    'going', 'completely',
  ]);
  const lowerTokens = text.toLowerCase().match(/\b[a-z]{5,12}\b/g) ?? [];
  for (const tok of lowerTokens) {
    if (COMMON_WORDS.has(tok)) continue;
    const pattern = new RegExp(`\\b(?:with|on|in|at|using|via|\\+)\\s+${tok}\\b`, 'i');
    if (pattern.test(text)) anchors.push(tok);
  }

  return { pass: anchors.length > 0, anchors: Array.from(new Set(anchors)) };
}
