import { env } from '@/lib/env';

/**
 * Resolve a path against the public app URL. Use this instead of
 * `new URL(path, request.url)` for any redirect that targets a page on
 * our own domain — `request.url` reflects the upstream URL seen by Next
 * (often `http://localhost:8080/...` behind a reverse proxy), which would
 * leak as the `Location` header to the browser.
 */
export function appUrl(path: string): URL {
  return new URL(path, env.NEXT_PUBLIC_APP_URL);
}
