import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// apps/web's vitest config has two test surfaces:
//
//   1. Route / lib tests under test/** -- node environment, mirrors
//      packages/shared. WebCrypto comes from Node 20+'s globalThis.crypto
//      (Workerd's WebCrypto API is a subset of the same spec).
//
//   2. React hook / component tests under src/** -- happy-dom environment so
//      renderHook from @testing-library/react can mount a tree. Kept narrow
//      so we don't accidentally run server-side Cloudflare-context code under
//      jsdom. Uses @vitejs/plugin-react so .tsx files compile (tsconfig
//      sets `"jsx": "preserve"` which leaves JSX un-transformed otherwise).
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node",
          environment: "node",
          include: ["test/**/*.test.ts"],
        },
      },
      {
        plugins: [react()],
        test: {
          name: "dom",
          environment: "happy-dom",
          include: [
            "src/**/__tests__/**/*.test.ts",
            "src/**/__tests__/**/*.test.tsx",
          ],
        },
        resolve: {
          alias: {
            "@": new URL("./src/", import.meta.url).pathname,
          },
        },
      },
    ],
  },
});
