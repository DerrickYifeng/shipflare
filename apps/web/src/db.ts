import { createDb, type DB } from "@shipflare/db";

// Singleton per Worker isolate. The D1 binding is a stable object across
// requests within an isolate; rebuilding the drizzle instance every call
// is wasteful and re-runs schema attachment.
let _db: DB | null = null;

export function getDb(env: { DB: D1Database }): DB {
  if (_db) return _db;
  _db = createDb(env.DB);
  return _db;
}
