import type { NextConfig } from "next";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

// Wires up `next dev` so route handlers can call `getCloudflareContext()` —
// during local dev OpenNext spins up a wrangler proxy to expose the actual
// D1 / Service Binding / asset bindings instead of returning undefined.
// In production this is a no-op (the OpenNext-built Worker already provides
// the real context).
initOpenNextCloudflareForDev();

const config: NextConfig = {
  reactStrictMode: true,
  async redirects() {
    return [
      { source: "/today", destination: "/briefing", permanent: true },
      { source: "/calendar", destination: "/briefing", permanent: true },
    ];
  },
};

export default config;
