import { describe, it, expect, vi, afterEach } from "vitest";
import {
  runSkill,
  parseFrontmatter,
  substituteArguments,
} from "../src/runner";

// ---------------------------------------------------------------------------
// Anthropic SDK mock
//
// The Anthropic client assigns `this.messages` inside the constructor, so
// `Anthropic.prototype.messages` is undefined and vi.spyOn cannot attach to
// it.  We use vi.mock at module level instead, which lets us swap the
// `messages.create` implementation per-test via the module-level mock fn.
// ---------------------------------------------------------------------------

// Mutable reference so individual tests can swap the implementation.
const mockCreate = vi.fn();

vi.mock("@anthropic-ai/sdk", () => {
  return {
    default: class MockAnthropic {
      messages = { create: mockCreate };
      constructor(_opts: unknown) {}
    },
  };
});

/** Reset to a clean success response before each data-part test. */
function setupMockSuccess() {
  mockCreate.mockResolvedValue({
    id: "msg_test",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "{}" }],
    model: "claude-sonnet-4-6",
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  });
}

/** Configure the mock to throw. */
function setupMockThrow() {
  mockCreate.mockRejectedValue(new Error("mock-throw"));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("parseFrontmatter", () => {
  it("returns defaults when no frontmatter is present", () => {
    const { frontmatter, body } = parseFrontmatter("just a body, no fm");
    expect(frontmatter.model).toBe("claude-sonnet-4-6");
    expect(frontmatter.maxTokens).toBe(2048);
    expect(frontmatter.system).toBeUndefined();
    expect(frontmatter.context).toBe("inline");
    expect(body).toBe("just a body, no fm");
  });

  it("parses model + maxTokens + system from YAML", () => {
    const md = [
      "---",
      "name: example",
      "model: claude-haiku-4-5",
      "maxTokens: 256",
      "system: short directive",
      "---",
      "body content",
    ].join("\n");
    const { frontmatter, body } = parseFrontmatter(md);
    expect(frontmatter.model).toBe("claude-haiku-4-5");
    expect(frontmatter.maxTokens).toBe(256);
    expect(frontmatter.system).toBe("short directive");
    expect(body).toBe("body content");
  });

  it("falls back to default maxTokens on invalid numeric value", () => {
    const md = ["---", "maxTokens: notanumber", "---", "body"].join("\n");
    const { frontmatter } = parseFrontmatter(md);
    expect(frontmatter.maxTokens).toBe(2048);
  });

  it("parses optional context field", () => {
    const md = "---\nname: x\ncontext: fork\n---\nbody";
    const { frontmatter } = parseFrontmatter(md);
    expect(frontmatter.context).toBe("fork");
  });
});

describe("substituteArguments", () => {
  it("replaces a string placeholder", () => {
    expect(substituteArguments("hello {name}", { name: "world" })).toBe(
      "hello world",
    );
  });

  it("replaces all occurrences of the same key", () => {
    expect(substituteArguments("{x}+{x}", { x: "1" })).toBe("1+1");
  });

  it("JSON.stringifies non-string values", () => {
    const out = substituteArguments("params: {p}", { p: { a: 1, b: [2] } });
    expect(out).toBe('params: {"a":1,"b":[2]}');
  });

  it("leaves unknown placeholders intact", () => {
    expect(substituteArguments("{a} {b}", { a: "x" })).toBe("x {b}");
  });
});

describe("runSkill", () => {
  it("throws a helpful error on unknown skill name", async () => {
    await expect(
      runSkill({ name: "nonexistent-skill", args: {}, env: { ANTHROPIC_API_KEY: "" } }),
    ).rejects.toThrow(/Unknown skill/);
  });
});

describe("runSkill data parts", () => {
  afterEach(() => {
    mockCreate.mockReset();
  });

  it("emits data-skill-start before execution and data-skill-finish on success", async () => {
    setupMockSuccess();
    const writes: unknown[] = [];
    const writer = { write: (chunk: unknown) => writes.push(chunk) };
    await runSkill({
      name: "noop-test-skill",
      args: {},
      writer: writer as { write: (chunk: unknown) => void },
      parentRunId: "p_1",
      userId: "u_1",
      env: {
        ANTHROPIC_API_KEY: "fake",
        TELEMETRY: { writeDataPoint: vi.fn() } as unknown as AnalyticsEngineDataset,
      },
    });
    expect((writes[0] as { type: string }).type).toBe("data-skill-start");
    expect((writes[0] as { data: { skillName: string } }).data.skillName).toBe(
      "noop-test-skill",
    );
    expect(
      (writes[0] as { data: { parentRunId: string } }).data.parentRunId,
    ).toBe("p_1");
    expect(
      (writes[writes.length - 1] as { type: string }).type,
    ).toBe("data-skill-finish");
    expect(
      (writes[writes.length - 1] as { data: { status: string } }).data.status,
    ).toBe("ok");
  });

  it("emits data-skill-finish status=error on throw and re-raises", async () => {
    setupMockThrow();
    const writes: unknown[] = [];
    const writer = { write: (chunk: unknown) => writes.push(chunk) };
    await expect(
      runSkill({
        name: "throwing-test-skill",
        args: {},
        writer: writer as { write: (chunk: unknown) => void },
        userId: "u_2",
        env: {
          ANTHROPIC_API_KEY: "fake",
          TELEMETRY: { writeDataPoint: vi.fn() } as unknown as AnalyticsEngineDataset,
        },
      }),
    ).rejects.toThrow();
    expect(
      (writes[writes.length - 1] as { type: string }).type,
    ).toBe("data-skill-finish");
    expect(
      (writes[writes.length - 1] as { data: { status: string } }).data.status,
    ).toBe("error");
  });

  it("writes telemetry data point with duration", async () => {
    setupMockSuccess();
    const writeDataPoint = vi.fn();
    await runSkill({
      name: "noop-test-skill",
      args: {},
      userId: "u_3",
      env: {
        ANTHROPIC_API_KEY: "fake",
        TELEMETRY: { writeDataPoint } as unknown as AnalyticsEngineDataset,
      },
    });
    expect(writeDataPoint).toHaveBeenCalledOnce();
    const call = (writeDataPoint.mock.calls[0] as [{ indexes: string[]; blobs: string[]; doubles: number[] }])[0];
    expect(call.indexes[0]).toBe("skill_invocation");
    expect(call.blobs[0]).toBe("noop-test-skill");
    expect(call.blobs[1]).toBe("ok");
    expect(call.doubles[0]).toBeGreaterThanOrEqual(0);
  });

  it("runs without writer present (legacy callers)", async () => {
    setupMockSuccess();
    await expect(
      runSkill({
        name: "noop-test-skill",
        args: {},
        userId: "u_4",
        env: {
          ANTHROPIC_API_KEY: "fake",
          TELEMETRY: { writeDataPoint: vi.fn() } as unknown as AnalyticsEngineDataset,
        },
      }),
    ).resolves.not.toThrow();
  });
});
