// Spike #8 — Service Binding callee Worker.
//
// Sibling Worker invoked by `shipflare-spike` via the `CALLEE` services
// binding. Echoes back path / method / headers / timestamp so the caller
// can prove zero-network in-process dispatch worked.
//
// Phase 1 analog: `apps/core` exposes RPC-shaped routes that `apps/web`
// invokes through a service binding, with no public DNS / TLS hop.

interface Env {
  // empty for the spike — callee doesn't need bindings of its own
}

export default {
  async fetch(request: Request, _env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    return Response.json({
      pathReceived: url.pathname,
      methodReceived: request.method,
      headerEcho: Object.fromEntries(request.headers),
      timestamp: Date.now(),
      callee: "shipflare-spike-callee",
    });
  },
} satisfies ExportedHandler<Env>;
