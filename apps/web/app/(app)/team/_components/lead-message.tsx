"use client";

import { memo, type CSSProperties } from "react";
import { ROLE_REGISTRY } from "@shipflare/shared";
import { AgentDot } from "./agent-dot";
import { MessageMarkdown } from "./message-markdown";
import { ReasoningPart } from "../../chat/_components/reasoning-part";
import { ToolInvocation } from "../../chat/_components/tool-invocation";
import type { ToolInvocationData } from "../../chat/_components/tool-invocation";
import { NestedAgentRun } from "../../chat/_components/nested-agent-run";
import { SkillPart } from "../../chat/_components/skill-part";
import { StepAnchor } from "../../chat/_components/step-anchor";
import { EMPLOYEE_REGISTRY } from "@/lib/employee-registry-client";

interface LeadMessageProps {
  /**
   * UIMessage `parts` array from `useCmoChat`. May contain text,
   * reasoning, skill markers, step anchors, and tool invocations.
   */
  parts: ReadonlyArray<unknown>;
  /** True while chunks are still arriving — appends a soft breathing dot row. */
  streaming?: boolean;
  /** Nested-agent run timelines keyed by tool-call id (from `consult` tool). */
  agentRunsByToolCall: Record<string, unknown[]>;
}

function displayNameForRole(role: string): string {
  const entry = (ROLE_REGISTRY as Record<string, { displayName: string } | undefined>)[role];
  return entry?.displayName ?? role;
}

const row: CSSProperties = {
  display: "flex",
  gap: 10,
  marginBottom: 14,
  animation: "sf-fade-in var(--sf-dur-slow, 300ms) var(--sf-ease-swift)",
};

const body: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  minWidth: 0,
  flex: 1,
};

const header: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  fontSize: 13,
};

const name: CSSProperties = {
  fontWeight: 500,
  color: "var(--sf-fg-1)",
  letterSpacing: "-0.01em",
};

function renderPart(
  part: unknown,
  index: number,
  agentRunsByToolCall: Record<string, unknown[]>,
  streaming: boolean,
): React.ReactNode {
  const p = part as Record<string, unknown>;
  const typeStr = String(p["type"] ?? "");

  if (typeStr === "text") {
    const text = String(p["text"] ?? "");
    if (!text) return null;
    return (
      <div key={index} style={{ fontSize: 14, color: "var(--sf-fg-1)" }}>
        <MessageMarkdown source={text} />
      </div>
    );
  }

  if (typeStr === "reasoning") {
    return (
      <ReasoningPart
        key={index}
        text={String(p["text"] ?? "")}
        isStreaming={streaming}
      />
    );
  }

  if (typeStr === "data-skill-start" || typeStr === "data-skill-finish") {
    return (
      <SkillPart
        key={index}
        part={p as unknown as Parameters<typeof SkillPart>[0]["part"]}
      />
    );
  }

  if (typeStr === "data-step") {
    return (
      <StepAnchor
        key={index}
        part={p as Parameters<typeof StepAnchor>[0]["part"]}
      />
    );
  }

  if (typeStr.startsWith("tool-") || typeStr === "dynamic-tool") {
    const toolName =
      typeStr === "dynamic-tool"
        ? String(p["toolName"] ?? "")
        : typeStr.replace(/^tool-/, "");
    const toolCallId = String(p["toolCallId"] ?? "");

    if (toolName === "consult") {
      const input = p["input"];
      const employeeId =
        input && typeof input === "object" && "employee" in input
          ? String((input as Record<string, unknown>)["employee"] ?? "")
          : "";
      const meta = EMPLOYEE_REGISTRY[employeeId];
      return (
        <NestedAgentRun
          key={index}
          label={meta?.displayName ?? employeeId}
          childRun={
            agentRunsByToolCall[toolCallId] as Parameters<
              typeof NestedAgentRun
            >[0]["childRun"]
          }
        />
      );
    }

    const invocation: ToolInvocationData = {
      toolCallId,
      toolName,
      state:
        (p["state"] as ToolInvocationData["state"]) ?? "input-available",
      input: p["input"],
      output: p["output"],
      errorText:
        typeof p["errorText"] === "string" ? p["errorText"] : undefined,
    };
    return <ToolInvocation key={index} invocation={invocation} />;
  }

  // Unknown / unrenderable part — fall back to nothing.
  return null;
}

function LeadMessageImpl({ parts, streaming = false, agentRunsByToolCall }: LeadMessageProps) {
  // Team-desk's CMO is the only assistant role surfaced at the top level.
  // Subagents appear inside <NestedAgentRun> cards via the `consult` tool.
  const role = "cmo";
  const displayName = displayNameForRole(role);

  const hasAnyText = parts.some((p) => {
    const part = p as Record<string, unknown>;
    return part["type"] === "text" && String(part["text"] ?? "").length > 0;
  });

  return (
    <div
      style={row}
      role="article"
      aria-label={`${displayName} said`}
      aria-busy={streaming}
      data-streaming={streaming ? "true" : "false"}
    >
      <AgentDot role={role} displayName={displayName} size={28} />
      <div style={body}>
        <div style={header}>
          <span style={name}>{displayName}</span>
        </div>
        {parts.map((p, i) =>
          renderPart(p, i, agentRunsByToolCall, streaming),
        )}
        {streaming && !hasAnyText && <StreamingDots />}
      </div>
    </div>
  );
}

export const LeadMessage = memo(LeadMessageImpl);

/**
 * Three-dot breathing indicator, inline at the end of a streaming bubble.
 * Matches Railway's StreamingDots exactly.
 */
function StreamingDots() {
  const wrap: CSSProperties = {
    display: "inline-flex",
    gap: 3,
    alignItems: "center",
    marginLeft: 6,
    verticalAlign: "baseline",
  };
  const dot: CSSProperties = {
    width: 5,
    height: 5,
    borderRadius: "50%",
    background: "currentColor",
    opacity: 0.35,
    animation: "sf-breathe 1.2s ease-in-out infinite",
  };
  return (
    <span style={wrap} aria-label="Still streaming">
      <span style={{ ...dot, animationDelay: "0ms" }} />
      <span style={{ ...dot, animationDelay: "180ms" }} />
      <span style={{ ...dot, animationDelay: "360ms" }} />
      <style>{`
        @keyframes sf-breathe {
          0%, 80%, 100% { opacity: 0.2; transform: scale(0.85); }
          40% { opacity: 0.9; transform: scale(1.1); }
        }
      `}</style>
    </span>
  );
}
