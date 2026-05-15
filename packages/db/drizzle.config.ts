import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/schema.ts",
  out: "./migrations",
  dialect: "sqlite",
  // For local migration generation against a wrangler-managed D1, we don't need
  // dbCredentials — drizzle-kit produces SQL files that `wrangler d1 migrations
  // apply` consumes. Set dbCredentials only if running `drizzle-kit push` against
  // a remote D1 via the HTTP API directly.
});
