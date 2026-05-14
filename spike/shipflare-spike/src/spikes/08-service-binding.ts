// Spike #8 — Service Binding (caller side).
//
// Invokes the sibling `shipflare-spike-callee` Worker through the
// `CALLEE` services binding. vitest-pool-workers resolves the binding
// via an auxiliary worker registered in `vitest.config.mts` (the
// canonical TS implementation in `../../../shipflare-spike-callee/src/
// index.ts` is what `wrangler dev` and production deploy run; the
// auxiliary stub mirrors its echo contract for the test path).
//
// Returns 503 (with hint) if the binding is somehow unbound at
// runtime — defensive only; both paths are covered by the test.
//
// Phase 1 mirror: `apps/web` calls `apps/core` over the same binding
// shape (`env.CORE.fetch(...)`), so the call site below is the
// reference pattern.

import type { Env } from "../index";

export default async function handler(_req: Request, env: Env): Promise<Response> {
  // The binding is declared required in wrangler.jsonc + the generated
  // runtime types, but vitest-pool-workers can leave the slot unbound
  // (no callee Worker running). Cast through `unknown` so the runtime
  // null-check survives strict typing.
  const callee = (env.CALLEE as unknown) as Fetcher | undefined;
  if (!callee) {
    return Response.json(
      {
        error: "CALLEE binding not available",
        hint: "Run `wrangler dev` in BOTH spike/shipflare-spike AND spike/shipflare-spike-callee, or deploy the callee first.",
      },
      { status: 503 },
    );
  }

  const t = Date.now();
  const res = await callee.fetch(
    new Request("https://internal/test-echo", {
      method: "POST",
      headers: {
        "x-shipflare-internal": "1",
        "x-test": "spike-08",
        "content-type": "application/json",
      },
      body: JSON.stringify({ message: "hello from caller" }),
    }),
  );
  const latencyMs = Date.now() - t;
  const calleeBody = await res.json();

  return Response.json({
    calleeStatus: res.status,
    calleeBody,
    latencyMs,
    note: "Service Binding is zero-network; latencyMs should be < 5ms typically.",
  });
}
