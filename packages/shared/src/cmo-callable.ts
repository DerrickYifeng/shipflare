/**
 * Wire shapes for CMO's @callable RPC surface.
 *
 * Defines the 13 callables the browser invokes via
 * `useAgent({agent:'cmo'}).stub.foo(...)` (see useCmoStub in apps/web). The
 * CMO class in apps/core implements these as @callable methods; this
 * interface is the contract.
 *
 * Cross-package source dependencies are avoided: apps/web imports types
 * from here, not from apps/core.
 */

import type { RoleSlug } from "./role-registry";

export interface PlanItemRow {
  id: string;
  skill: string;
  channel: string;
  params_json: string;
  status: string;
  owner_role: string;
  scheduled_for: number | null;
  started_at: number | null;
  completed_at: number | null;
}

export interface DraftRow {
  id: string;
  draft_id: string;
  employee: string;
  kind: string;
  channel: string;
  preview: string;
  created_at: number;
  decided_at: number | null;
  decision: string | null;
}

export interface MemoryRow {
  id: string;
  content: string;
  added_at: number;
  source_conversation_id: string | null;
}

export interface AgentTranscriptRow {
  id: number;
  conversation_id: string | null;
  from_role: string;
  kind: string;
  summary: string | null;
  payload_json: string | null;
  ts: number;
}

export interface ConversationRow {
  id: string;
  started_at: number;
  ended_at: number | null;
  title: string | null;
}

export interface RosterRow {
  role: RoleSlug;
  /** Always "active" — queryRoster derives from EMPLOYEE_REGISTRY (no hire/fire model). */
  status: "active";
  hired_at: number;
  hire_config_json: string | null;
}

export interface CmoCallableSurface {
  queryFounderContext(): Promise<Record<string, string>>;
  queryPlanItems(opts?: {
    status?: string;
    ownerRole?: string;
    limit?: number;
  }): Promise<PlanItemRow[]>;
  cancelPlanItem(args: { id: string }): Promise<{ id: string; status: "cancelled" }>;
  approveDraft(args: { draftId: string }): Promise<{ draftId: string; decision: "approved" }>;
  rejectDraft(args: { draftId: string; reason?: string }): Promise<{
    draftId: string;
    decision: "rejected";
  }>;
  queryDrafts(opts?: { limit?: number }): Promise<DraftRow[]>;
  rememberThis(args: {
    content: string;
    sourceConversationId?: string;
    sourceMessageTs?: number;
  }): Promise<{ id: string; ok: true }>;
  forgetThis(args: { id: string }): Promise<{ id: string; ok: true }>;
  queryMemory(opts?: { limit?: number }): Promise<MemoryRow[]>;
  queryAgentTranscript(args: {
    role: string;
    limit?: number;
  }): Promise<AgentTranscriptRow[]>;
  queryRoster(): Promise<RosterRow[]>;
  listConversations(opts?: { limit?: number }): Promise<ConversationRow[]>;
  startNewConversation(args?: { title?: string }): Promise<{ conversationId: string }>;
}
