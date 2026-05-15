"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { useTeamEvents } from "@/hooks/use-team-events";
import { createCmoClient, type CmoClient } from "@/lib/mcp-client";
import { useToast } from "@/components/ui/toast";
import { ROLE_REGISTRY } from "@shipflare/shared";
import type { TeamUser, RosterEmployee, ConversationMeta, PlanItemRow, DraftRow } from "./types";
import { LeftRail } from "./left-rail";
import { Conversation } from "./conversation";
import { StickyComposer } from "./sticky-composer";
import { StatusBanner } from "./status-banner";
import { RightPanel } from "./right-panel";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface TeamDeskProps {
  user: TeamUser;
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

export function TeamDesk({ user }: TeamDeskProps) {
  // ---- Toast (for surfacing approve / new-conversation errors) ----
  const { toast } = useToast();

  // ---- Client ref (used for one-shot queries, separate from chat) ----
  const clientRef = useRef<CmoClient | null>(null);

  // ---- Left rail data ----
  const [employees, setEmployees] = useState<RosterEmployee[]>([]);
  const [conversations, setConversations] = useState<ConversationMeta[]>([]);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  // ---- Right panel data ----
  const [planItems, setPlanItems] = useState<PlanItemRow[]>([]);
  const [drafts, setDrafts] = useState<DraftRow[]>([]);
  const [loadingDraftId, setLoadingDraftId] = useState<string | null>(null);

  // ---- Connection / init ----
  const [connectError, setConnectError] = useState<string | null>(null);
  const [initDone, setInitDone] = useState(false);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const client = await createCmoClient();
        if (cancelled) {
          void client.close();
          return;
        }
        clientRef.current = client;

        // Parallel initial fetches.
        const [rosterRaw, convList, items, pendingDrafts] = await Promise.all([
          client.queryRoster(),
          client.listConversations(20),
          client.queryPlanItems<PlanItemRow>({ limit: 50 }),
          client.queryDrafts<DraftRow>({ status: "pending", limit: 20 }),
        ]);

        if (cancelled) return;

        setEmployees(rosterRaw.map(toRosterEmployee));
        setConversations(convList);
        // Select the most-recent conversation if any.
        if (convList.length > 0 && convList[0]) {
          setSelectedConversationId(convList[0].id);
        }
        setPlanItems(items);
        setDrafts(pendingDrafts);
        setInitDone(true);
      } catch (err) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : "Failed to connect";
        setConnectError(msg);
        setInitDone(true);
      }
    })();

    return () => {
      cancelled = true;
      const c = clientRef.current;
      clientRef.current = null;
      if (c) void c.close();
    };
  }, []);

  // ---- Chat via useTeamEvents ----
  const {
    messages,
    sendMessage: _sendMessage,
    status,
    error: chatError,
  } = useTeamEvents({
    teamId: user.id,
    conversationId: selectedConversationId,
  });

  // Memoised so the useEffect below has a stable dependency. Reads from
  // clientRef.current only, so no closure deps needed.
  const refreshPanelData = useCallback(async () => {
    const client = clientRef.current;
    if (!client) return;
    try {
      const [items, pendingDrafts] = await Promise.all([
        client.queryPlanItems<PlanItemRow>({ limit: 50 }),
        client.queryDrafts<DraftRow>({ status: "pending", limit: 20 }),
      ]);
      setPlanItems(items);
      setDrafts(pendingDrafts);
    } catch {
      // non-fatal — panel will show stale data on next user action
    }
  }, []);

  // After each message completion, refresh plan items + drafts.
  const prevMessageCount = useRef(0);
  useEffect(() => {
    const newCount = messages.length;
    if (newCount > prevMessageCount.current && newCount > 0) {
      prevMessageCount.current = newCount;
      const lastMsg = messages[messages.length - 1];
      // Refresh after assistant responds (not after every user message).
      if (lastMsg && (lastMsg.type === "agent_text" || lastMsg.type === "error")) {
        void refreshPanelData();
      }
    }
  }, [messages, refreshPanelData]);

  // ---- Composer submit ----
  const handleSend = useCallback(
    async (text: string) => {
      await _sendMessage(text);
    },
    [_sendMessage],
  );

  // ---- Conversation management ----
  const handleNewConversation = useCallback(async () => {
    const client = clientRef.current;
    if (!client || creating) return;
    setCreating(true);
    try {
      const { conversationId } = await client.startNewConversation();
      setSelectedConversationId(conversationId);
      // Refresh conversation list.
      const convList = await client.listConversations(20);
      setConversations(convList);
    } catch {
      // Silently fail — conversation list will be stale but user can retry.
    } finally {
      setCreating(false);
    }
  }, [creating]);

  // ---- Draft actions ----
  const handleApproveDraft = useCallback(
    async (id: string) => {
      const client = clientRef.current;
      if (!client) return;
      setLoadingDraftId(id);
      try {
        await client.approveDraft(id);
        setDrafts((prev) => prev.filter((d) => d.id !== id));
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Approve failed";
        toast(`Couldn't approve draft: ${msg}`, "error");
      } finally {
        setLoadingDraftId(null);
      }
    },
    [toast],
  );

  const handleRejectDraft = useCallback(
    async (id: string) => {
      const client = clientRef.current;
      if (!client) return;
      setLoadingDraftId(id);
      try {
        await client.rejectDraft(id);
        setDrafts((prev) => prev.filter((d) => d.id !== id));
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Reject failed";
        toast(`Couldn't reject draft: ${msg}`, "error");
      } finally {
        setLoadingDraftId(null);
      }
    },
    [toast],
  );

  // ---- Render ----
  const composerDisabled = !initDone || status === "connecting" || status === "sending" || !!connectError;
  const displayError = connectError ?? chatError;

  return (
    <main style={OUTER} aria-label="Team desk">
      {/* Left: employee roster + conversation list */}
      <LeftRail
        employees={employees}
        conversations={conversations}
        selectedConversationId={selectedConversationId}
        onSelectConversation={setSelectedConversationId}
        onNewConversation={() => void handleNewConversation()}
        creating={creating}
      />

      {/* Center: conversation + composer */}
      <div style={CENTER}>
        {displayError && (
          <div style={{ padding: "8px 20px 0" }}>
            <StatusBanner status="error" error={displayError} />
          </div>
        )}
        {status === "connecting" && !displayError && (
          <div style={{ padding: "8px 20px 0" }}>
            <StatusBanner status="connecting" error={null} />
          </div>
        )}
        {status === "sending" && !displayError && (
          <div style={{ padding: "8px 20px 0" }}>
            <StatusBanner status="sending" error={null} />
          </div>
        )}

        <Conversation messages={messages} />

        <StickyComposer
          onSend={handleSend}
          disabled={composerDisabled}
          placeholder={
            connectError
              ? "Connection error — reload to reconnect"
              : status === "connecting"
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
      />
    </main>
  );
}
