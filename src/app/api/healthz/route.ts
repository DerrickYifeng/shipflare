import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * Public liveness probe for Railway and other orchestrators.
 *
 * Unauthenticated and intentionally lightweight — no database or Redis
 * queries. Returns 200 as long as the Next.js process is alive, which is
 * all Railway needs to consider the container healthy.
 *
 * The authenticated `/api/health` endpoint handles app-level health scoring
 * and remains separate.
 */
export async function GET() {
  return NextResponse.json({ status: 'ok' });
}

