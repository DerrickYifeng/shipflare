/**
 * Format a fractional-hour value into a display string.
 *
 * Examples:
 *   formatHour(9)    → "9:00a"
 *   formatHour(14.5) → "2:30p"
 *   formatHour(13, '24h') → "13:00"
 *
 * Matches handoff pages.jsx `formatHour`. Honors the user's 12h/24h setting
 * when a second arg is passed.
 */
export function formatHour(h: number, clock: '12h' | '24h' = '12h'): string {
  const hr = Math.floor(h);
  const min = Math.round((h - hr) * 60);
  if (clock === '24h') {
    return `${String(hr).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
  }
  const ap = hr >= 12 ? 'p' : 'a';
  const hh = hr === 0 ? 12 : hr > 12 ? hr - 12 : hr;
  return `${hh}:${String(min).padStart(2, '0')}${ap}`;
}
