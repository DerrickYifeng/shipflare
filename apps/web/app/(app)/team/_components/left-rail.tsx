"use client";

import type { CSSProperties } from "react";
import type { RosterEmployee, ConversationMeta } from "./types";
import { AgentDot } from "./agent-dot";
import { AgentStatusPill, type AgentStatus } from "./agent-status-pill";
import { roleCodeForRole } from "./agent-accent";

interface LeftRailProps {
  employees: RosterEmployee[];
  conversations: ConversationMeta[];
  selectedConversationId: string | null;
  onSelectConversation: (id: string) => void;
  onNewConversation: () => void;
  creating: boolean;
}

function rosterStatusToPill(s: RosterEmployee["status"], taskCount?: number): AgentStatus {
  if (s === "fired") return "fired";
  if (s === "idle") return "idle";
  if (taskCount !== undefined && taskCount > 0) return "working";
  return "active";
}

function EmployeeRow({ employee }: { employee: RosterEmployee }) {
  const row: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "8px 10px",
    borderRadius: "var(--sf-radius-md)",
    cursor: "default",
  };

  const name: CSSProperties = {
    fontSize: 13,
    fontFamily: "var(--sf-font-text)",
    fontWeight: 500,
    color: "var(--sf-fg-1)",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  };

  const roleTag: CSSProperties = {
    fontSize: 10,
    fontFamily: "var(--sf-font-mono)",
    color: "var(--sf-fg-3)",
    textTransform: "uppercase",
    letterSpacing: 0.4,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  };

  const pillStatus = rosterStatusToPill(employee.status, employee.taskCount);

  return (
    <div style={row} role="listitem">
      <AgentDot role={employee.role} displayName={employee.displayName} size={28} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={name}>{employee.displayName}</div>
        <div style={roleTag}>{roleCodeForRole(employee.role, employee.displayName)}</div>
      </div>
      <AgentStatusPill status={pillStatus} taskCount={employee.taskCount} />
    </div>
  );
}

function ConversationRow({
  conv,
  selected,
  onSelect,
}: {
  conv: ConversationMeta;
  selected: boolean;
  onSelect: () => void;
}) {
  const label = conv.title ?? new Date(conv.started_at).toLocaleDateString();
  const row: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "7px 12px",
    borderRadius: "var(--sf-radius-md)",
    cursor: "pointer",
    background: selected ? "var(--sf-accent-light)" : "transparent",
    color: selected ? "var(--sf-accent)" : "var(--sf-fg-2)",
    fontSize: 13,
    fontFamily: "var(--sf-font-text)",
    transition: `background var(--sf-dur-fast) var(--sf-ease)`,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    border: "none",
    width: "100%",
    textAlign: "left",
  };

  return (
    <button type="button" style={row} onClick={onSelect} aria-current={selected ? "page" : undefined}>
      {label}
    </button>
  );
}

const SECTION_HEADER: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "6px 12px",
  fontSize: 10,
  fontFamily: "var(--sf-font-mono)",
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: 0.4,
  color: "var(--sf-fg-3)",
};

export function LeftRail({
  employees,
  conversations,
  selectedConversationId,
  onSelectConversation,
  onNewConversation,
  creating,
}: LeftRailProps) {
  const outer: CSSProperties = {
    position: "sticky",
    top: 72,
    display: "flex",
    flexDirection: "column",
    maxHeight: "calc(100vh - 88px)",
    padding: 10,
    borderRadius: "var(--sf-radius-xl)",
    background: "var(--sf-bg-primary)",
    width: 260,
    flexShrink: 0,
  };

  const scroll: CSSProperties = {
    flex: 1,
    minHeight: 0,
    overflowY: "auto",
    paddingRight: 2,
  };

  const newConvBtn: CSSProperties = {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    marginTop: 2,
    padding: "6px 0",
    borderRadius: "var(--sf-radius-md)",
    border: "none",
    background: "transparent",
    color: "var(--sf-accent)",
    fontSize: 13,
    fontFamily: "var(--sf-font-text)",
    fontWeight: 500,
    cursor: creating ? "not-allowed" : "pointer",
    opacity: creating ? 0.5 : 1,
    width: "100%",
    transition: `opacity var(--sf-dur-fast) var(--sf-ease)`,
  };

  return (
    <aside style={outer} aria-label="Team sidebar">
      <div style={scroll}>
        {/* Roster section */}
        <div style={SECTION_HEADER}>
          <span>Team</span>
        </div>
        <div role="list" aria-label="Employees">
          {employees.map((emp) => (
            <EmployeeRow key={emp.role} employee={emp} />
          ))}
          {employees.length === 0 && (
            <div
              style={{
                padding: "8px 12px",
                fontSize: 13,
                color: "var(--sf-fg-4)",
                fontFamily: "var(--sf-font-text)",
              }}
            >
              Loading team…
            </div>
          )}
        </div>

        {/* Conversations section */}
        <div style={{ ...SECTION_HEADER, marginTop: 16 }}>
          <span>Conversations</span>
        </div>
        <div role="list" aria-label="Conversations">
          {conversations.map((c) => (
            <ConversationRow
              key={c.id}
              conv={c}
              selected={c.id === selectedConversationId}
              onSelect={() => onSelectConversation(c.id)}
            />
          ))}
          {conversations.length === 0 && (
            <div
              style={{
                padding: "8px 12px",
                fontSize: 13,
                color: "var(--sf-fg-4)",
                fontFamily: "var(--sf-font-text)",
              }}
            >
              No conversations yet.
            </div>
          )}
        </div>
      </div>

      {/* New conversation button */}
      <button
        type="button"
        style={newConvBtn}
        onClick={onNewConversation}
        disabled={creating}
        aria-label="Start a new conversation"
      >
        <span aria-hidden="true">+</span>
        New conversation
      </button>
    </aside>
  );
}
