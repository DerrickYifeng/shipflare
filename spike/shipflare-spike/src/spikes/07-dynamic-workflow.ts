// Spike #7 — Dynamic Workflow handler.
//
// Two routes share the `/spike/07` prefix:
//   POST  /spike/07          → create a workflow instance, return its id
//   GET   /spike/07/status   → fetch status of an existing instance (?id=)
//
// The test issues one create call, captures the returned id, and polls
// `/status?id=<id>` until the instance reaches a terminal state.

import type { Env } from "../index";

export default async function handler(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);

  // Status sub-route. Strict suffix match so future spike paths can't shadow it.
  if (url.pathname.endsWith("/status")) {
    const id = url.searchParams.get("id");
    if (!id) return new Response("missing ?id=", { status: 400 });
    const instance = await env.EX_WORKFLOW.get(id);
    const status = await instance.status();
    return Response.json({ status });
  }

  // Default: create a new instance. The `runId` lets us correlate the
  // instance's eventual output back to this request without a second binding.
  const runId = crypto.randomUUID();
  const instance = await env.EX_WORKFLOW.create({ params: { runId } });
  return Response.json({ id: instance.id, runId });
}
