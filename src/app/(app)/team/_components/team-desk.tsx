'use client';

import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import {
  useTeamEvents,
  type TeamActivityMessage,
} from '@/hooks/use-team-events';
import { useToast } from '@/components/ui/toast';
import { LeftRail, type LeftRailMember } from './left-rail';
import { Conversation, type ConversationMember } from './conversation';
import { TaskPanel } from './task-panel';
import {
  StickyComposer,
  type StickyComposerHandle,
  type StickyComposerSendResult,
} from './sticky-composer';
import { StatusBanner } from './status-banner';
import { OnboardingBanner } from './onboarding-banner';
import type { BudgetSegment } from './token-budget';
import {
  stitchLeadMessages,
  type DelegationTask,
  type TaskLookup,
  type TeamRunLookup,
  type TeamRunMeta,
} from './conversation-reducer';
import type { ConversationMeta } from './conversation-meta';
import { useNewConversation } from './use-new-conversation';

export interface TeamDeskMember {
  id: string;
  agentType: string;
  displayName: string;
  status: string;
  taskCount?: number;
  notes?: readonly string[];
  subtitle?: string;
}

export interface TeamDeskProps {
  teamId: string;
  coordinatorId: string | null;
  fromOnboarding?: boolean;
  teamLead: TeamDeskMember | null;
  specialists: readonly TeamDeskMember[];
  initialMessages: TeamActivityMessage[];
  spentUsd: number;
  weeklyBudgetUsd: number;
  budgetSegments: readonly BudgetSegment[];
  activeRunId: string | null;
  activeRunStartedAt: string | null;
  isLive: boolean;
  leadMessage: string;
  draftsInFlight: number;
  inReview: number;
  approvedReady: number;
  turns: number;
  taskLookup?: TaskLookup;
  runLookup?: TeamRunLookup;
  /** ChatGPT-style conversation list for the sidebar. */
  conversations?: readonly ConversationMeta[];
  /** The conversation id to focus on mount. */
  initialConversationId?: string | null;
}

const LEFT_WIDTH = 280;
const RIGHT_WIDTH = 380;
const GRID_GAP = 20;
const H_PAD = 24;

/**
 * Team desk — ChatGPT-style chat surface. State model:
 *
 *   selectedConversationId      ← the ONLY focus state
 *   conversationList            ← sidebar rows (sort by updatedAt desc)
 *   allMessages                 ← live SSE stream ∪ per-conversation fetches
 *   threadMessages              ← allMessages.filter(m.conversationId === selected)
 *
 * No runId-keyed UI state, no `runByConv` mapping, no optimistic run
 * bookkeeping. Runs are a server-side implementation detail; the UI
 * only ever sees messages, grouped by the conversation they belong to.
 * Per-run dividers inside the thread are purely cosmetic.
 */
export function TeamDesk({
  teamId,
  coordinatorId,
  fromOnboarding = false,
  teamLead,
  specialists,
  initialMessages,
  spentUsd,
  weeklyBudgetUsd,
  budgetSegments,
  activeRunId,
  activeRunStartedAt,
  isLive,
  leadMessage,
  draftsInFlight,
  inReview,
  approvedReady,
  taskLookup,
  runLookup,
  conversations,
  initialConversationId,
}: TeamDeskProps) {
  // ---------- Focus + sidebar state ----------
  const [selectedConversationId, setSelectedConversationId] = useState<
    string | null
  >(initialConversationId ?? null);
  const [conversationList, setConversationList] = useState<
    readonly ConversationMeta[]
  >(() => conversations ?? []);
  const [pendingFocusMessageId, setPendingFocusMessageId] = useState<
    string | null
  >(null);

  // Per-conversation message fetches. When the user clicks an older
  // conversation whose rows fell off the initial snapshot window, we
  // load them here; SSE messages are merged on top via `allMessages`.
  const [fetchedMessages, setFetchedMessages] = useState<
    TeamActivityMessage[]
  >([]);
  const loadedConversationIdsRef = useRef<Set<string>>(new Set());

  const composerRef = useRef<StickyComposerHandle | null>(null);

  const focusComposer = useCallback(() => {
    composerRef.current?.focus();
  }, []);

  const prefillComposer = useCallback((text: string) => {
    composerRef.current?.setValue(text);
  }, []);

  const { toast } = useToast();
  const handleStall = useCallback(() => {
    toast(
      "Stream paused — the team's still working on it. The latest reply will appear on reconnect.",
      'error',
    );
  }, [toast]);

  const { messages: liveMessages, partials, toolInputPartials } = useTeamEvents({
    teamId,
    initialMessages,
    onStall: handleStall,
  });

  // Union of SSE stream + on-demand conversation fetches.
  // De-duped by id; keeps the SSE version (newer) when collision.
  const allMessages = useMemo<TeamActivityMessage[]>(() => {
    const byId = new Map<string, TeamActivityMessage>();
    for (const m of fetchedMessages) byId.set(m.id, m);
    for (const m of liveMessages) byId.set(m.id, m);
    return Array.from(byId.values()).sort((a, b) =>
      a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0,
    );
  }, [fetchedMessages, liveMessages]);

  // The ONE thing the conversation component renders.
  const threadMessages = useMemo<TeamActivityMessage[]>(() => {
    if (!selectedConversationId) return [];
    return allMessages.filter(
      (m) => m.conversationId === selectedConversationId,
    );
  }, [allMessages, selectedConversationId]);

  // Render backpressure for the thread view (Claude Code REPL pattern).
  const deferredThreadMessages = useDeferredValue(threadMessages);
  const deferredPartials = useDeferredValue(partials);
  const deferredToolInputPartials = useDeferredValue(toolInputPartials);

  // ---------- Fetch historical messages when a conversation is focused ----------
  useEffect(() => {
    if (!selectedConversationId) return;
    if (loadedConversationIdsRef.current.has(selectedConversationId)) return;

    const cid = selectedConversationId;
    loadedConversationIdsRef.current.add(cid);
    let cancelled = false;

    fetch(`/api/team/conversations/${encodeURIComponent(cid)}/messages`, {
      credentials: 'same-origin',
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((body: {
        messages?: Array<{
          id: string;
          runId: string | null;
          fromMemberId: string | null;
          toMemberId: string | null;
          type: string;
          content: string | null;
          metadata: Record<string, unknown> | null;
          createdAt: string;
        }>;
      }) => {
        if (cancelled || !Array.isArray(body.messages)) return;
        const mapped: TeamActivityMessage[] = body.messages.map((m) => ({
          id: m.id,
          runId: m.runId,
          conversationId: cid,
          teamId,
          from: m.fromMemberId,
          to: m.toMemberId,
          type: m.type,
          content: m.content,
          metadata: m.metadata,
          createdAt: m.createdAt,
        }));
        setFetchedMessages((prev) => {
          // Replace any prior fetch for this conversation so reloads
          // don't accumulate stale rows.
          const keep = prev.filter((m) => m.conversationId !== cid);
          return [...keep, ...mapped];
        });
      })
      .catch((err) => {
        // Allow retry on next click by removing from the loaded set.
        loadedConversationIdsRef.current.delete(cid);
        toast(
          err instanceof Error
            ? `Couldn't load conversation history: ${err.message}`
            : 'Network error loading conversation history.',
          'error',
        );
      });

    return () => {
      cancelled = true;
    };
  }, [selectedConversationId, teamId, toast]);

  // ---------- Sidebar reconciliation ----------
  // Hydrate from server props.
  useEffect(() => {
    if (!conversations) return;
    setConversationList((prev) => {
      const next = new Map<string, ConversationMeta>();
      for (const c of prev) next.set(c.id, c);
      for (const c of conversations) next.set(c.id, c);
      return Array.from(next.values()).sort((a, b) =>
        a.updatedAt > b.updatedAt ? -1 : 1,
      );
    });
  }, [conversations]);

  // Bump sidebar `updatedAt` from SSE deltas so the most recently
  // active conversation floats to the top. No status flags — every
  // conversation is always clickable and continuable.
  useEffect(() => {
    if (liveMessages.length === 0) return;
    const latestByConv = new Map<string, string>();
    for (const m of liveMessages) {
      if (!m.conversationId) continue;
      const existing = latestByConv.get(m.conversationId);
      if (!existing || m.createdAt > existing) {
        latestByConv.set(m.conversationId, m.createdAt);
      }
    }
    if (latestByConv.size === 0) return;

    setConversationList((prev) => {
      let changed = false;
      const next = prev.map((c) => {
        const latest = latestByConv.get(c.id);
        if (!latest) return c;
        if (latest <= c.updatedAt) return c;
        changed = true;
        return { ...c, updatedAt: latest };
      });
      if (!changed) return prev;
      return [...next].sort((a, b) => (a.updatedAt > b.updatedAt ? -1 : 1));
    });
  }, [liveMessages]);

  // Derive title from the first user_prompt in each conversation when
  // the server hasn't backfilled one yet.
  const titleByConv = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of allMessages) {
      if (m.type !== 'user_prompt' || !m.conversationId) continue;
      if (map.has(m.conversationId)) continue;
      const raw = (m.content ?? '').trim().replace(/\s+/g, ' ');
      if (!raw) continue;
      map.set(
        m.conversationId,
        raw.length > 60 ? `${raw.slice(0, 60).trimEnd()}…` : raw,
      );
    }
    return map;
  }, [allMessages]);

  const conversationListWithTitles = useMemo<readonly ConversationMeta[]>(
    () =>
      conversationList.map((c) =>
        c.title ? c : { ...c, title: titleByConv.get(c.id) ?? null },
      ),
    [conversationList, titleByConv],
  );

  // ---------- Delegation tasks (task panel, global view) ----------
  const allDelegationTasks = useMemo<DelegationTask[]>(() => {
    const nodes = stitchLeadMessages(liveMessages, taskLookup, partials);
    const out: DelegationTask[] = [];
    for (const n of nodes) {
      if (n.kind === 'lead') {
        for (const d of n.delegation) out.push(d);
      }
    }
    return out;
  }, [liveMessages, taskLookup, partials]);

  // ---------- Handlers ----------
  const handleSelectConversation = useCallback((conversationId: string) => {
    setSelectedConversationId(conversationId);
  }, []);

  const handleNewConversationCreated = useCallback(
    (conv: ConversationMeta) => {
      setConversationList((prev) => {
        if (prev.some((c) => c.id === conv.id)) return prev;
        return [conv, ...prev];
      });
      setSelectedConversationId(conv.id);
      requestAnimationFrame(() => composerRef.current?.focus());
    },
    [],
  );

  const { start: startNewConversation, creating: creatingConversation } =
    useNewConversation({
      teamId,
      onCreated: handleNewConversationCreated,
      onError: (err) =>
        toast(
          err instanceof Error
            ? `Couldn't start new conversation: ${err.message}`
            : 'Network error starting new conversation',
          'error',
        ),
    });

  const handleComposerSent = useCallback(
    (result: StickyComposerSendResult) => {
      if (!result.conversationId) return;
      const nowIso = new Date().toISOString();
      setConversationList((prev) =>
        prev
          .map((c) =>
            c.id === result.conversationId ? { ...c, updatedAt: nowIso } : c,
          )
          .sort((a, b) => (a.updatedAt > b.updatedAt ? -1 : 1)),
      );
    },
    [],
  );

  // Cancellable run — latest user_prompt in the focused thread whose
  // run hasn't emitted a completion/error yet.
  const cancellableRunId = useMemo<string | null>(() => {
    if (threadMessages.length === 0) return null;
    for (let i = threadMessages.length - 1; i >= 0; i -= 1) {
      const m = threadMessages[i];
      if (m.type !== 'user_prompt' || !m.runId) continue;
      const runId = m.runId;
      const hasTerminal = threadMessages.some(
        (x) =>
          x.runId === runId && (x.type === 'completion' || x.type === 'error'),
      );
      return hasTerminal ? null : runId;
    }
    return null;
  }, [threadMessages]);

  // Typing indicator for the focused thread: true when the latest
  // user_prompt in the thread hasn't yet been answered by a
  // completion/error event for the same run.
  const threadIsLive = useMemo(() => {
    for (let i = threadMessages.length - 1; i >= 0; i -= 1) {
      const m = threadMessages[i];
      if (m.type !== 'user_prompt' || !m.runId) continue;
      const runId = m.runId;
      const hasTerminal = threadMessages.some(
        (x) =>
          x.runId === runId && (x.type === 'completion' || x.type === 'error'),
      );
      return !hasTerminal;
    }
    return false;
  }, [threadMessages]);

  const focusCardNow = useCallback((messageId: string): void => {
    const el = document.querySelector<HTMLElement>(
      `[data-testid="subtask-card-${messageId}"]`,
    );
    window.dispatchEvent(
      new CustomEvent('sf:task-focus', { detail: { messageId } }),
    );
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.animate(
      [
        { boxShadow: '0 0 0 2px var(--sf-accent)' },
        { boxShadow: '0 0 0 2px transparent' },
      ],
      { duration: 900, easing: 'ease-out' },
    );
  }, []);

  const handleJumpToTask = useCallback(
    (messageId: string, runId: string | null) => {
      // Find which conversation the target run belongs to by scanning
      // messages. Falls back to the runLookup prop (initial SSR) when
      // the run's rows aren't yet in the SSE window.
      if (!runId) {
        focusCardNow(messageId);
        return;
      }
      let targetConvId: string | null = null;
      for (const m of allMessages) {
        if (m.runId === runId && m.conversationId) {
          targetConvId = m.conversationId;
          break;
        }
      }
      if (!targetConvId) {
        targetConvId = runLookup?.get(runId)?.conversationId ?? null;
      }
      if (targetConvId && targetConvId !== selectedConversationId) {
        setPendingFocusMessageId(messageId);
        setSelectedConversationId(targetConvId);
        return;
      }
      focusCardNow(messageId);
    },
    [allMessages, runLookup, selectedConversationId, focusCardNow],
  );

  // After a cross-conversation jump, wait for the new cards to hit the
  // DOM then scroll + pulse the target.
  useEffect(() => {
    if (!pendingFocusMessageId) return;
    let frame1 = 0;
    let frame2 = 0;
    frame1 = requestAnimationFrame(() => {
      frame2 = requestAnimationFrame(() => {
        focusCardNow(pendingFocusMessageId);
        setPendingFocusMessageId(null);
      });
    });
    return () => {
      cancelAnimationFrame(frame1);
      cancelAnimationFrame(frame2);
    };
  }, [pendingFocusMessageId, focusCardNow]);

  const handleCancelRun = useCallback(
    async (runId: string) => {
      try {
        const res = await fetch(
          `/api/team/run/${encodeURIComponent(runId)}/cancel`,
          { method: 'POST' },
        );
        if (!res.ok) {
          const detail = (await res
            .json()
            .catch(() => ({ error: `HTTP ${res.status}` }))) as {
            error?: string;
          };
          toast(
            detail.error === 'run_not_found'
              ? "Couldn't find that run to cancel."
              : `Couldn't cancel: ${detail.error ?? `HTTP ${res.status}`}`,
            'error',
          );
          return;
        }
      } catch (err) {
        toast(
          err instanceof Error
            ? `Network error: ${err.message}`
            : 'Network error — cancel not delivered.',
          'error',
        );
      }
    },
    [toast],
  );

  const handleCancelTask = useCallback(
    async (taskId: string) => {
      try {
        const res = await fetch(
          `/api/team/task/${encodeURIComponent(taskId)}/cancel`,
          { method: 'POST' },
        );
        if (!res.ok && res.status !== 200) {
          const detail = (await res
            .json()
            .catch(() => ({ error: `HTTP ${res.status}` }))) as {
            error?: string;
          };
          toast(
            detail.error === 'task_not_found'
              ? "Couldn't find that subtask to cancel."
              : `Couldn't cancel subtask: ${detail.error ?? `HTTP ${res.status}`}`,
            'error',
          );
        }
      } catch (err) {
        toast(
          err instanceof Error
            ? `Network error: ${err.message}`
            : 'Network error — subtask cancel not delivered.',
          'error',
        );
      }
    },
    [toast],
  );

  const handleRetryTask = useCallback(
    async (taskId: string) => {
      try {
        const res = await fetch(
          `/api/team/task/${encodeURIComponent(taskId)}/retry`,
          { method: 'POST' },
        );
        if (!res.ok) {
          const detail = (await res
            .json()
            .catch(() => ({ error: `HTTP ${res.status}` }))) as {
            error?: string;
          };
          toast(
            detail.error === 'task_not_found'
              ? "Couldn't find that subtask to retry."
              : `Couldn't retry subtask: ${detail.error ?? `HTTP ${res.status}`}`,
            'error',
          );
          return;
        }
        const body = (await res.json().catch(() => ({}))) as {
          runId?: string;
          conversationId?: string | null;
        };
        if (typeof body.conversationId === 'string') {
          const convId = body.conversationId;
          const nowIso = new Date().toISOString();
          setConversationList((prev) =>
            prev
              .map((c) =>
                c.id === convId ? { ...c, updatedAt: nowIso } : c,
              )
              .sort((a, b) => (a.updatedAt > b.updatedAt ? -1 : 1)),
          );
          setSelectedConversationId(convId);
          toast('Retrying subtask.', 'success');
        }
      } catch (err) {
        toast(
          err instanceof Error
            ? `Network error: ${err.message}`
            : 'Network error — retry not delivered.',
          'error',
        );
      }
    },
    [toast],
  );

  const allMembers = useMemo<TeamDeskMember[]>(
    () => (teamLead ? [teamLead, ...specialists] : [...specialists]),
    [teamLead, specialists],
  );

  const conversationMembers = useMemo<ConversationMember[]>(
    () =>
      allMembers.map((m) => ({
        id: m.id,
        agentType: m.agentType,
        displayName: m.displayName,
      })),
    [allMembers],
  );

  const leftRailLead = useMemo<LeftRailMember | null>(() => {
    if (!teamLead) return null;
    return {
      id: teamLead.id,
      agentType: teamLead.agentType,
      displayName: teamLead.displayName,
      status: teamLead.status,
      taskCount: teamLead.taskCount,
      notes: teamLead.notes,
    };
  }, [teamLead]);

  const leftRailSpecialists = useMemo<LeftRailMember[]>(
    () =>
      specialists.map((m) => ({
        id: m.id,
        agentType: m.agentType,
        displayName: m.displayName,
        status: m.status,
        taskCount: m.taskCount,
        notes: m.notes,
      })),
    [specialists],
  );

  // Build a fresh runLookup for the thread view: every run seen in
  // the filtered thread. Starts from the server-supplied lookup so
  // historical dividers keep their `trigger` / `goal` metadata.
  const threadRunLookup = useMemo<TeamRunLookup>(() => {
    const map = new Map<string, TeamRunMeta>();
    if (runLookup) {
      for (const [id, run] of runLookup) {
        if (run.conversationId === selectedConversationId) map.set(id, run);
      }
    }
    for (const m of threadMessages) {
      if (!m.runId || map.has(m.runId)) continue;
      map.set(m.runId, {
        id: m.runId,
        trigger: 'manual',
        goal: null,
        status: 'running',
        startedAt: m.createdAt,
        completedAt: null,
        conversationId: selectedConversationId,
      });
    }
    // Update status from terminal events within the thread.
    for (const m of threadMessages) {
      if (!m.runId) continue;
      const run = map.get(m.runId);
      if (!run) continue;
      if (m.type === 'completion') {
        map.set(m.runId, {
          ...run,
          status: 'completed',
          completedAt: run.completedAt ?? m.createdAt,
        });
      } else if (m.type === 'error') {
        const meta = m.metadata;
        const cancelled =
          meta && (meta as Record<string, unknown>)['cancelled'] === true;
        map.set(m.runId, {
          ...run,
          status: cancelled ? 'cancelled' : 'failed',
          completedAt: run.completedAt ?? m.createdAt,
        });
      }
    }
    return map;
  }, [runLookup, threadMessages, selectedConversationId]);

  const noopSelectMember = useCallback((_: string) => {
    /* workspace deleted — members are no longer selectable here */
  }, []);

  // ---------- Layout ----------
  const rootStyle: CSSProperties = {
    height: 'calc(100vh - 56px)',
    padding: `24px ${H_PAD}px 0`,
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
    overflow: 'hidden',
  };

  const gridStyle: CSSProperties = {
    display: 'grid',
    gridTemplateColumns: `${LEFT_WIDTH}px 1fr ${RIGHT_WIDTH}px`,
    gap: GRID_GAP,
    alignItems: 'stretch',
    flex: 1,
    minHeight: 0,
  };

  const columnBase: CSSProperties = {
    minHeight: 0,
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
  };

  const centerCol: CSSProperties = {
    ...columnBase,
    overflow: 'hidden',
  };

  const rightRail: CSSProperties = {
    ...columnBase,
    overflowY: 'auto',
  };

  const canCreate = !creatingConversation;

  return (
    <div className="ai-team-root" style={rootStyle}>
      <StatusBanner
        activeRunId={activeRunId}
        activeRunStartedAt={activeRunStartedAt}
        draftsInFlight={draftsInFlight}
        inReview={inReview}
        approvedReady={approvedReady}
        isLive={isLive}
        leadMessage={leadMessage}
      />
      {fromOnboarding && <OnboardingBanner />}

      <div className="ai-team-grid" style={gridStyle}>
        <div className="ai-team-left" style={columnBase}>
          <LeftRail
            teamLead={leftRailLead}
            specialists={leftRailSpecialists}
            activeMemberId={null}
            onSelect={noopSelectMember}
            spentUsd={spentUsd}
            weeklyBudgetUsd={weeklyBudgetUsd}
            budgetSegments={budgetSegments}
            conversations={conversationListWithTitles}
            selectedConversationId={selectedConversationId}
            onSelectConversation={handleSelectConversation}
            onNewConversation={startNewConversation}
            canCreate={canCreate}
            creating={creatingConversation}
          />
        </div>

        <div className="ai-team-center" style={centerCol}>
          <Conversation
            members={conversationMembers}
            coordinatorId={coordinatorId}
            messages={deferredThreadMessages}
            partials={deferredPartials}
            toolInputPartials={deferredToolInputPartials}
            taskLookup={taskLookup}
            runLookup={threadRunLookup}
            activeMemberId={null}
            onSelectMember={noopSelectMember}
            isLive={threadIsLive}
            onPrefillComposer={prefillComposer}
            onFocusComposer={focusComposer}
            focusPendingMessageId={pendingFocusMessageId}
          />
        </div>

        <div className="ai-team-right" style={rightRail}>
          <TaskPanel
            tasks={allDelegationTasks}
            onJumpToTask={handleJumpToTask}
            onCancelTask={handleCancelTask}
            onRetryTask={handleRetryTask}
            thisWeek={{
              completed: approvedReady,
              awaiting: inReview,
              inFlight: draftsInFlight,
            }}
          />
        </div>
      </div>

      <StickyComposer
        ref={composerRef}
        teamId={teamId}
        leftColumnWidth={LEFT_WIDTH}
        rightColumnWidth={RIGHT_WIDTH}
        gap={GRID_GAP}
        horizontalPadding={H_PAD}
        onSent={handleComposerSent}
        cancellableRunId={cancellableRunId}
        onCancel={handleCancelRun}
        conversationId={selectedConversationId}
      />

      <style jsx global>{`
        .ai-team-left > aside {
          position: relative !important;
          top: auto !important;
          max-height: none !important;
          height: 100%;
        }

        .ai-team-root,
        .ai-team-root *,
        .ai-team-root *::before,
        .ai-team-root *::after {
          scrollbar-width: thin;
          scrollbar-color: rgba(0, 0, 0, 0.18) transparent;
        }
        .ai-team-root *::-webkit-scrollbar {
          width: 10px;
          height: 10px;
        }
        .ai-team-root *::-webkit-scrollbar-track {
          background: transparent;
        }
        .ai-team-root *::-webkit-scrollbar-thumb {
          background-color: rgba(0, 0, 0, 0.12);
          border-radius: 999px;
          border: 3px solid transparent;
          background-clip: padding-box;
          transition: background-color 160ms var(--sf-ease-swift, ease);
        }
        .ai-team-root *:hover::-webkit-scrollbar-thumb,
        .ai-team-root *:focus-within::-webkit-scrollbar-thumb {
          background-color: rgba(0, 0, 0, 0.22);
        }
        .ai-team-root *::-webkit-scrollbar-thumb:hover {
          background-color: rgba(0, 0, 0, 0.36);
        }
        .ai-team-root *::-webkit-scrollbar-thumb:active {
          background-color: rgba(0, 0, 0, 0.48);
        }
        @media (max-width: 1024px) {
          .ai-team-root {
            height: auto !important;
            overflow: visible !important;
          }
          .ai-team-grid {
            grid-template-columns: 280px 1fr !important;
            min-height: 0 !important;
          }
          .ai-team-right {
            position: static !important;
            grid-column: 1 / -1 !important;
            margin-top: 20px;
            overflow: visible !important;
          }
          .ai-team-center {
            overflow: visible !important;
          }
          .ai-team-center > section {
            overflow: visible !important;
            padding-bottom: 220px !important;
          }
          .ai-team-composer-grid {
            grid-template-columns: 280px 1fr !important;
          }
        }
        @media (max-width: 768px) {
          .ai-team-grid {
            grid-template-columns: 1fr !important;
          }
          .ai-team-left > aside {
            position: static !important;
            max-height: none !important;
          }
          .ai-team-composer-wrap {
            left: 0 !important;
          }
          .ai-team-composer-grid {
            grid-template-columns: 1fr !important;
          }
          .ai-team-composer-grid > div {
            grid-column: 1 / -1 !important;
          }
        }
      `}</style>
    </div>
  );
}
