// Sanity-check endpoint. Mirrors apps/core's /healthz so deployment
// pipelines and uptime checks can probe both Workers identically.

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return Response.json({ ok: true, app: "web", ts: Date.now() });
}
