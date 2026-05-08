/**
 * Build the absolute URL of ShipFlare's own Reddit reply handoff page.
 * Reddit has no native "compose comment" intent URL, so reply handoff
 * happens on a ShipFlare-owned page (`/handoff/reddit/[draftId]`) which
 * shows the draft, copies it to the clipboard, and deep-links to the
 * Reddit thread's reply box.
 */
export function buildRedditHandoffPageUrl(draftId: string): string {
  if (!draftId || !draftId.trim()) {
    throw new Error('buildRedditHandoffPageUrl: draftId is required');
  }
  const base = (
    process.env.NEXT_PUBLIC_BASE_URL ?? 'http://localhost:3000'
  ).replace(/\/$/, '');
  return `${base}/handoff/reddit/${draftId}`;
}
