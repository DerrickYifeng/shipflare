import { describe, it, expect } from "vitest";
import * as schema from "../src/schema";

describe("D1 schema exports", () => {
  it("exports all 5 tables", () => {
    expect(schema.user).toBeDefined();
    expect(schema.session).toBeDefined();
    expect(schema.account).toBeDefined();
    expect(schema.verification).toBeDefined();
    expect(schema.channels).toBeDefined();
  });

  it("user table has expected columns", () => {
    // Drizzle table objects have a $inferSelect type and the column accessors
    // are properties on the table itself. Smoke-check a few:
    const userTable = schema.user as unknown as Record<string, unknown>;
    expect(userTable.id).toBeDefined();
    expect(userTable.email).toBeDefined();
    expect(userTable.emailVerified).toBeDefined();
    expect(userTable.createdAt).toBeDefined();
  });

  it("channels table has the right columns", () => {
    const tbl = schema.channels as unknown as Record<string, unknown>;
    // Drizzle stores enum values on the column metadata; smoke-check existence
    expect(tbl.platform).toBeDefined();
    expect(tbl.oauthTokenEncrypted).toBeDefined();
    expect(tbl.userId).toBeDefined();
    expect(tbl.status).toBeDefined();
  });
});
