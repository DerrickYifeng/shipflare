import { describe, it, expect } from "vitest";
import { makeConsultTool } from "../src/agents/lib/consult-tool";

describe("makeConsultTool — caller-scoped enum", () => {
  it("CMO can consult hog and smm but not itself", () => {
    const t = makeConsultTool("cmo");
    const enumValues = extractEmployeeEnum(t);
    expect(enumValues).toContain("hog");
    expect(enumValues).toContain("smm");
    expect(enumValues).not.toContain("cmo");
  });

  it("HoG can consult SMM but not CMO or itself", () => {
    const t = makeConsultTool("hog");
    const enumValues = extractEmployeeEnum(t);
    expect(enumValues).toContain("smm");
    expect(enumValues).not.toContain("cmo");
    expect(enumValues).not.toContain("hog");
  });

  it("SMM can consult HoG but not CMO or itself", () => {
    const t = makeConsultTool("smm");
    const enumValues = extractEmployeeEnum(t);
    expect(enumValues).toContain("hog");
    expect(enumValues).not.toContain("cmo");
    expect(enumValues).not.toContain("smm");
  });
});

// Zod 4.x's enum internals are not officially stable. If the shape below
// breaks, adapt — what we ultimately want is the set of values the
// `employee` field accepts. Options:
//   (a) parse a probe and check which strings parse OK
//   (b) inspect schema._def.entries (Zod 4) or schema._def.values (Zod 3)
function extractEmployeeEnum(t: any): string[] {
  // Try Zod 4 shape first
  const employeeSchema = t.inputSchema?.shape?.employee;
  const def = employeeSchema?._def;
  if (Array.isArray(def?.values)) return def.values;
  if (Array.isArray(def?.entries)) return def.entries.map((e: any) => e[0] ?? e);
  // Fallback: brute-force probe with all three known ids
  return (["cmo", "hog", "smm"] as const).filter(id =>
    employeeSchema?.safeParse?.(id)?.success === true
  );
}
