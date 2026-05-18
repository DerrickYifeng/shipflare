"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useCmoAgent } from "@/hooks/use-cmo-agent";
import { useCmoChat } from "@/hooks/use-cmo-chat";
import { useCmoStub } from "@/hooks/use-cmo-stub";
import { useToast } from "@/components/ui/toast";
import { ROLE_REGISTRY } from "@shipflare/shared";
import type { TeamUser, RosterEmployee, ConversationMeta, PlanItemRow, DraftRow } from "./types";
import { LeftRail } from "./left-rail";
import { Conversation } from "./conversation";
import { StickyComposer } from "./sticky-composer";
import { StatusBanner } from "./status-banner";
import { RightPanel } from "./right-panel";
import {
  TeammateTranscriptDrawer,
  type TranscriptDrawerTarget,
} from "./teammate-transcript-drawer";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface TeamDeskProps {
  user: TeamUser;
  /** Bare host of apps/core for the chat WebSocket — see `useCmoChat`. */
  coreHost: string;
}

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

const OUTER: CSSProperties = {
  display: "flex",
  flexDirection: "row",
  gap: 20,
  padding: "24px 24px 0",
  minHeight: "calc(100vh - 72px)",
  alignItems: "flex-start",
};

const CENTER: CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: "flex",
  flexDirection: "column",
  background: "var(--sf-bg-secondary)",
  borderRadius: "var(--sf-radius-xl)",
  boxShadow: "var(--sf-shadow-card)",
  overflow: "hidden",
  minHeight: "calc(100vh - 112px)",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalise a raw roster row from queryRoster() into our local view model. */
function toRosterEmployee(raw: {
  role: string;
  status: string;
  hired_at: number;
  hire_config_json: string | null;
}): RosterEmployee {
  const entry = (ROLE_REGISTRY as Record<string, { displayName: string } | undefined>)[raw.role];
  return {
    role: raw.role,
    displayName: entry?.displayName ?? raw.role,
    status: raw.status === "active" ? "active" : raw.status === "fired" ? "fired" : "idle",
    hired_at: raw.hired_at,
  };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function TeamDesk({ user, coreHost }: TeamDeskProps) {
  // ---- Toast (for surfacing approve / new-conversation errors) ----
  const { toast } = useToast();

  // ---- Left rail data ----
  const [employees, setEmployees] = useState<RosterEmployee[]>([]);
  const [conversations, setConversations] = useState<ConversationMeta[]>([]);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  // ---- Right panel data ----
  const [planItems, setPlanItems] = useState<PlanItemRow[]>([]);
  const [drafts, setDrafts] = useState<DraftRow[]>([]);
  const [loadingDraftId, setLoadingDraftId] = useState<string | null>(null);
  const [cancellingPlanId, setCancellingPlanId] = useState<string | null>(null);

  // ---- Transcript drawer ----
  const [drawerTarget, setDrawerTarget] = useState<TranscriptDrawerTarget | null>(
    null,
  );

  // ---- Connection / init ----
  const [connectError, setConnectError] = useState<string | null>(null);
  const [initDone, setInitDone] = useState(false);

  // ---- Chat via useCmoChat (CF-native AIChatAgent WebSocket transport) ----
  //
  // useCmoAgent owns the single WebSocket; useCmoChat and useCmoStub both
  // consume it, so chat + RPC share ONE socket per page tree (the agents
  // SDK does NOT de-dupe useAgent calls per options). Token-based JWT
  // handshake; auto-reconnect.
  //
  // `conversationId` is forwarded so the founder can flip between threads
  // via the left rail. Until the SDK rebuilds the WS on id change,
  // re-keying via `useCmoChat`'s `id` arg is enough.
  const { agent, error: agentError } = useCmoAgent({
    userId: user.id,
    coreHost,
  });

  const {
    messages,
    sendMessage,
    isStreaming,
    agentRunsByToolCall,
  } = useCmoChat({
    agent,
    conversationId: selectedConversationId ?? undefined,
  });

  // Typed @callable RPC stub on the same WS as useCmoChat.
  const stub = useCmoStub({ agent });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [rosterRaw, convList, items, pendingDrafts] = await Promise.all([
          stub.queryRoster(),
          stub.listConversations({ limit: 20 }),
          stub.queryPlanItems({ limit: 50 }),
          stub.queryDrafts({ limit: 20 }),
        ]);
        if (cancelled) return;
        const activeStatuses = new Set([
          "pending",
          "drafting",
          "executing",
          "in_progress",
        ]);
        const counts = new Map<string, number>();
        for (const item of items) {
          const role = (item as { owner_role?: string }).owner_role;
          const status = (item as { status?: string }).status;
          if (!role || !status) continue;
          if (!activeStatuses.has(status)) continue;
          counts.set(role, (counts.get(role) ?? 0) + 1);
        }
        setEmployees(
          rosterRaw.map((raw) => {
            const base = toRosterEmployee(raw);
            return { ...base, taskCount: counts.get(base.role) ?? 0 };
          }),
        );
        setConversations(convList);
        if (convList.length > 0 && convList[0]) {
          setSelectedConversationId(convList[0].id);
        }
        setPlanItems(items as unknown as PlanItemRow[]);
        setDrafts(pendingDrafts as unknown as DraftRow[]);
        setInitDone(true);
      } catch (err) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : "Failed to load";
        setConnectError(msg);
        setInitDone(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [stub]);

  useEffect(() => {
    if (agentError && !connectError) {
      setConnectError(agentError);
    }
  }, [agentError, connectError]);

  // Memoised so the useEffect below has a stable dependency. The stub
  // identity is stable across renders (useMemo on agent), so refreshes
  // only re-create when the underlying WS does.
  const refreshPanelData = useCallback(async () => {
    try {
      const [items, pendingDrafts] = await Promise.all([
        stub.queryPlanItems({ limit: 50 }),
        stub.queryDrafts({ limit: 20 }),
      ]);
      setPlanItems(items as unknown as PlanItemRow[]);
      setDrafts(pendingDrafts as unknown as DraftRow[]);
      // Recompute per-role task counts so the left-rail badges stay live.
      const activeStatuses = new Set([
        "pending",
        "drafting",
        "executing",
        "in_progress",
      ]);
      const counts = new Map<string, number>();
      for (const item of items) {
        const role = (item as { owner_role?: string }).owner_role;
        const status = (item as { status?: string }).status;
        if (!role || !status) continue;
        if (!activeStatuses.has(status)) continue;
        counts.set(role, (counts.get(role) ?? 0) + 1);
      }
      setEmployees((prev) =>
        prev.map((e) => ({ ...e, taskCount: counts.get(e.role) ?? 0 })),
      );
    } catch {
      // non-fatal — panel will show stale data on next user action
    }
  }, [stub]);

  // Refresh plan items + drafts whenever an assistant stream finishes.
  // `isStreaming` flipping from true → false marks turn completion in the
  // new hook (replaces the legacy completion / error message types).
  const wasStreaming = useRef(false);
  useEffect(() => {
    if (wasStreaming.current && !isStreaming) {
      void refreshPanelData();
    }
    wasStreaming.current = isStreaming;
  }, [isStreaming, refreshPanelData]);

  // ---- Composer submit ----
  const handleSend = useCallback(
    async (text: string) => {
      sendMessage({ text });
    },
    [sendMessage],
  );

  // ---- Conversation management ----
  const handleNewConversation = useCallback(async () => {
    if (creating) return;
    setCreating(true);
    try {
      const { conversationId } = await stub.startNewConversation();
      setSelectedConversationId(conversationId);
      // Refresh conversation list.
      const convList = await stub.listConversations({ limit: 20 });
      setConversations(convList);
    } catch {
      // Silently fail — conversation list will be stale but user can retry.
    } finally {
      setCreating(false);
    }
  }, [creating, stub]);

  // ---- Draft actions ----
  const handleApproveDraft = useCallback(
    async (id: string) => {
      setLoadingDraftId(id);
      try {
        await stub.approveDraft({ draftId: id });
        setDrafts((prev) => prev.filter((d) => d.id !== id));
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Approve failed";
        toast(`Couldn't approve draft: ${msg}`, "error");
      } finally {
        setLoadingDraftId(null);
      }
    },
    [stub, toast],
  );

  const handleRejectDraft = useCallback(
    async (id: string) => {
      setLoadingDraftId(id);
      try {
        await stub.rejectDraft({ draftId: id });
        setDrafts((prev) => prev.filter((d) => d.id !== id));
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Reject failed";
        toast(`Couldn't reject draft: ${msg}`, "error");
      } finally {
        setLoadingDraftId(null);
      }
    },
    [stub, toast],
  );

  const handleCancelPlanItem = useCallback(
    async (id: string) => {
      setCancellingPlanId(id);
      try {
        await stub.cancelPlanItem({ id });
        // Optimistically flip status in local state; next refresh will
        // confirm.
        setPlanItems((prev) =>
          prev.map((p) =>
            p.id === id ? { ...p, status: "cancelled" } : p,
          ),
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Cancel failed";
        toast(`Couldn't cancel task: ${msg}`, "error");
      } finally {
        setCancellingPlanId(null);
      }
    },
    [stub, toast],
  );

  const handleSelectEmployee = useCallback((employee: RosterEmployee) => {
    setDrawerTarget({
      role: employee.role,
      displayName: employee.displayName,
    });
  }, []);

  // ---- Status banner state (derived from the new hook) ----
  // The legacy `useTeamEvents` exposed `connecting | ready | sending | error`.
  // `useCmoChat` only exposes `isStreaming`; connection errors surface as
  // initial stub-query failures (`connectError`). Map streaming → "sending"
  // for visual continuity.
  const derivedStatus: "idle" | "connecting" | "sending" | "error" = useMemo(() => {
    if (connectError) return "error";
    if (!initDone) return "connecting";
    if (isStreaming) return "sending";
    return "idle";
  }, [connectError, initDone, isStreaming]);

  // ---- Render ----
  const composerDisabled = !initDone || isStreaming || !!connectError;
  const displayError = connectError;

  return (
    <main style={OUTER} aria-label="Team desk">
      {/* Left: employee roster + conversation list */}
      <LeftRail
        employees={employees}
        conversations={conversations}
        selectedConversationId={selectedConversationId}
        onSelectConversation={setSelectedConversationId}
        onNewConversation={() => void handleNewConversation()}
        onSelectEmployee={handleSelectEmployee}
        creating={creating}
      />

      {/* Center: conversation + composer */}
      <div style={CENTER}>
        {displayError && (
          <div style={{ padding: "8px 20px 0" }}>
            <StatusBanner status="error" error={displayError} />
          </div>
        )}
        {derivedStatus === "connecting" && !displayError && (
          <div style={{ padding: "8px 20px 0" }}>
            <StatusBanner status="connecting" error={null} />
          </div>
        )}
        {derivedStatus === "sending" && !displayError && (
          <div style={{ padding: "8px 20px 0" }}>
            <StatusBanner status="sending" error={null} />
          </div>
        )}

        <Conversation
          messages={messages}
          isStreaming={isStreaming}
          agentRunsByToolCall={agentRunsByToolCall}
          onPromptSelect={(p) => void handleSend(p)}
        />

        <StickyComposer
          onSend={handleSend}
          disabled={composerDisabled}
          placeholder={
            connectError
              ? "Connection error — reload to reconnect"
              : !initDone
                ? "Connecting…"
                : "Message your team…"
          }
        />
      </div>

      {/* Right: plan items + pending drafts */}
      <RightPanel
        planItems={planItems}
        drafts={drafts}
        onApproveDraft={handleApproveDraft}
        onRejectDraft={handleRejectDraft}
        loadingDraftId={loadingDraftId}
        onCancelPlanItem={handleCancelPlanItem}
        cancellingPlanId={cancellingPlanId}
      />

      <TeammateTranscriptDrawer
        target={drawerTarget}
        onClose={() => setDrawerTarget(null)}
      />
    </main>
  );
}
