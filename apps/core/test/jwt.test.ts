import { describe, expect, it } from "vitest";
import { signJwt, verifyJwt } from "../src/lib/jwt";

const SECRET = "test-secret-32-bytes-of-randomness-aaaa";

describe("jwt HS256", () => {
  it("signs and verifies a payload", async () => {
    const token = await signJwt({ userId: "u1", role: "cmo" }, SECRET, 60);
    const payload = (await verifyJwt(token, SECRET)) as {
      userId: string;
      role: string;
      iat: number;
      exp: number;
    };
    expect(payload.userId).toBe("u1");
    expect(payload.role).toBe("cmo");
    expect(payload.iat).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
    expect(payload.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("rejects malformed token", async () => {
    await expect(verifyJwt("not.a.jwt", SECRET)).rejects.toThrow();
  });

  it("rejects token signed with different secret", async () => {
    const token = await signJwt({ userId: "u1" }, SECRET, 60);
    await expect(
      verifyJwt(token, "different-secret-32-bytes-padding-x"),
    ).rejects.toThrow();
  });

  it("rejects expired token", async () => {
    const token = await signJwt({ userId: "u1" }, SECRET, -1); // already expired
    await expect(verifyJwt(token, SECRET)).rejects.toThrow(/expired/);
  });
});
