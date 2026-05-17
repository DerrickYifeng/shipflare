type AgentEventKind = 'tool_invocation' | 'skill_invocation' | 'agent_run';

export interface AgentEvent {
  kind: AgentEventKind;
  userId: string;
  runId?: string | null;
  blobs: string[];
  doubles: number[];
}

export function writeAgentEvent(env: { TELEMETRY?: AnalyticsEngineDataset }, event: AgentEvent): void {
  if (!env.TELEMETRY) return;  // tolerate absent binding (e.g., in unit tests / preview)
  env.TELEMETRY.writeDataPoint({
    indexes: [event.kind, event.userId, event.runId ?? ''],
    blobs: event.blobs,
    doubles: event.doubles,
  });
}
