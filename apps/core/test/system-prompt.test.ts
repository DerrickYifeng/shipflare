import { describe, it, expect } from "vitest";
import { loadSystemPrompt } from "../src/agents/lib/system-prompt";

describe("loadSystemPrompt", () => {
  it("includes the preamble + colleague list + role-specific prompt", async () => {
    const prompt = await loadSystemPrompt("cmo");
    expect(prompt).toContain("You are an autonomous AI employee at ShipFlare");
    expect(prompt).toContain("## Your colleagues");
    expect(prompt).toContain("'hog': Head of Growth");
    expect(prompt).toContain("'smm': Social Media Manager");
  });

  it("excludes self from colleague list", async () => {
    const prompt = await loadSystemPrompt("hog");
    expect(prompt).not.toMatch(/'hog':/);
  });

  it("excludes CMO from peer colleague lists", async () => {
    const prompt = await loadSystemPrompt("smm");
    expect(prompt).not.toMatch(/'cmo':/);
  });

  it("includes the role-specific section after the preamble", async () => {
    const prompt = await loadSystemPrompt("smm");
    // The new SMM SYSTEM.md has "Social Media Manager" / drafting language;
    // assert a few of those tokens appear AFTER the "## Role" marker.
    const roleIdx = prompt.indexOf("## Role");
    expect(roleIdx).toBeGreaterThan(0);
    const role = prompt.slice(roleIdx);
    expect(role.toLowerCase()).toMatch(/social media|drafting|voice/);
  });
});
