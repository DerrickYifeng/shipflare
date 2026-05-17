"use client";

import type { AgentToolRunState } from "agents";
import { TextPart } from "./text-part";
import { ReasoningPart } from "./reasoning-part";
import { ToolInvocation } from "./tool-invocation";
import type { ToolInvocationData } from "./tool-invocation";

function renderPart(p: unknown, i: number): React.ReactNode {
  const part = p as Record<string, unknown>;

  if (part["type"] === "text") {
    return <TextPart key={i} text={String(part["text"] ?? "")} />;
  }

  if (part["type"] === "reasoning") {
    // ReasoningUIPart from ai v6 has a direct `text` field.
    return <ReasoningPart key={i} text={String(part["text"] ?? "")} />;
  }

  // Tool parts have type `tool-<name>` or `dynamic-tool`.
  const typeStr = String(part["type"] ?? "");
  if (typeStr.startsWith("tool-") || typeStr === "dynamic-tool") {
    const invocation: ToolInvocationData = {
      toolCallId: String(part["toolCallId"] ?? ""),
      toolName:
        typeStr === "dynamic-tool"
          ? String(part["toolName"] ?? "")
          : typeStr.replace(/^tool-/, ""),
      state: (part["state"] as ToolInvocationData["state"]) ?? "input-available",
      input: part["input"] ?? part["args"],
      output: part["output"] ?? part["result"],
      errorText:
        typeof part["errorText"] === "string" ? part["errorText"] : undefined,
    };
    return <ToolInvocation key={i} invocation={invocation} />;
  }

  return null;
}

export function NestedAgentRun({
  label,
  childRun,
}: {
  label: string;
  childRun?: AgentToolRunState;
}) {
  if (!childRun) {
    return (
      <div
        data-testid="nested-agent-run"
        className="border-l-2 border-muted pl-2 my-1 text-sm text-muted-foreground"
      >
        Consulting {label}…
      </div>
    );
  }

  return (
    <div
      data-testid="nested-agent-run"
      data-employee={label}
      className="border-l-2 border-muted pl-2 my-1"
    >
      <div className="text-xs font-semibold">
        {label}{" "}
        <span className="text-muted-foreground">[{childRun.status}]</span>
      </div>
      {childRun.parts.map((p, i) => renderPart(p, i))}
      {childRun.error && (
        <div className="text-xs text-destructive mt-1">{childRun.error}</div>
      )}
    </div>
  );
}
