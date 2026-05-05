// <task-notification> XML synthesis — single source of truth.
//
// Engine PDF §3.6 verbatim XML schema. Used when an agent_runs row exits
// (completed | failed | killed) to produce the user-role mailbox payload
// the parent's runAgent loop will see on its next idle drain.

export type TerminalStatus = 'completed' | 'failed' | 'killed';

export interface NotificationInput {
  agentId: string;
  status: TerminalStatus;
  summary: string;
  finalText: string;
  usage: {
    totalTokens: number;
    toolUses: number;
    durationMs: number;
  };
}

const XML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => XML_ESCAPES[c]);
}

/**
 * Build a `<task-notification>` XML payload for the given exit. The
 * shape matches engine PDF §3.6 verbatim — including the `<r>` tag
 * name (a deliberate engine choice retained for prompt-quoting
 * compatibility).
 */
export function synthesizeTaskNotification(input: NotificationInput): string {
  return `<task-notification>
  <task-id>${escapeXml(input.agentId)}</task-id>
  <status>${input.status}</status>
  <summary>${escapeXml(input.summary)}</summary>
  <r>${escapeXml(input.finalText)}</r>
  <usage>
    <total_tokens>${input.usage.totalTokens}</total_tokens>
    <tool_uses>${input.usage.toolUses}</tool_uses>
    <duration_ms>${input.usage.durationMs}</duration_ms>
  </usage>
</task-notification>`;
}
