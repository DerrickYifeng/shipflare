import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "./schema";

export * from "./schema";

// Re-export the drizzle expression helpers callers need for WHERE clauses.
// Keeping this surface in `@shipflare/db` rather than asking each app to add
// its own `drizzle-orm` dep means the ORM version is pinned in exactly one
// place (this package's `package.json`).
export { and, eq, or, inArray } from "drizzle-orm";

export type DB = DrizzleD1Database<typeof schema>;

export function createDb(d1: D1Database): DB {
  return drizzle(d1, { schema });
}
