/**
 * Escape user-controlled strings for safe insertion into HTML text or
 * attribute contexts. Covers the five characters required by the OWASP
 * HTML Entity Encoding rule.
 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
