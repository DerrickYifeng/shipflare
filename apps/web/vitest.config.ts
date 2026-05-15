import { defineConfig } from "vitest/config";

/**
 * apps/web's vitest config mirrors packages/shared — node environment, tests
 * under `test/**`. Component / route tests that need WebCrypto rely on
 * Node 20+'s globalThis.crypto (Workerd's WebCrypto API is a subset of the
 * same spec; HS256 sign/verify behaves identically here).
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
