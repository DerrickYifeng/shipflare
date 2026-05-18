/**
 * Resolve the bare host (no scheme) of apps/core for the founder-facing
 * chat WebSocket. The browser's `useAgent` defaults to
 * `window.location.host`, which is wrong on the Phase 11 custom-domain
 * split (apps/web on `app-*.shipflare.ai`, apps/core on
 * `mcp-*.shipflare.ai`). Pages that mount `useCmoChat` must derive this
 * server-side and pass it as a prop — the client bundle has no env
 * access.
 *
 * Falls back to `localhost:3001` (apps/core's default `wrangler dev`
 * port) when `CORE_PUBLIC_URL` is unset, matching the same fallback in
 * `/api/mcp-token`.
 */
export function resolveCoreHost(corePublicUrl: string | undefined): string {
  const url = corePublicUrl ?? "http://localhost:3001";
  try {
    return new URL(url).host;
  } catch {
    return "localhost:3001";
  }
}
