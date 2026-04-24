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
import type { BudgetSegment } from './token-budget';
import {
  stitchLeadMessages,
  type DelegationTask,
  type TaskLookup,
  type TeamRunLookup,
  type TeamRunMeta,
} from './conversation-reducer';
import type { SessionMeta } from './session-meta';
import { useNewSession, type NewSessionResult } from './use-new-session';

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
  sessions?: readonly SessionMeta[];
}

const LEFT_WIDTH = 280;
const RIGHT_WIDTH = 380;
const GRID_GAP = 20;
const H_PAD = 24;

export function TeamDesk({
  teamId,
  coordinatorId,
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
  sessions,
}: TeamDeskProps) {
  const [selectedRunId, setSelectedRunId] = useState<string | null>(
    activeRunId ?? null,
  );
  // Set by the right-rail Task panel when the user clicks a row whose
  // run isn't currently selected. Drives (a) Conversation's choice
  // between jump-to-tail and unstick, and (b) a post-commit effect
  // below that scrolls + pulse-highlights the target card.
  const [pendingFocusMessageId, setPendingFocusMessageId] = useState<
    string | null
  >(null);
  const [sessionList, setSessionList] = useState<readonly SessionMeta[]>(
    () => sessions ?? [],
  );
  const [runLookupState, setRunLookupState] = useState<TeamRunLookup>(
    () => runLookup ?? new Map<string, TeamRunMeta>(),
  );
  // Client-side draft session id (one at a time). Set when `+ New session`
  // is clicked, cleared on composer send (draft gets promoted to a real
  // run) or when the user navigates away from the draft.
  const [draftSessionId, setDraftSessionId] = useState<string | null>(null);
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
  const { messages, partials, toolInputPartials } = useTeamEvents({
    teamId,
    initialMessages,
    onStall: handleStall,
  });

  // Render backpressure — borrowed from Claude Code's REPL (engine/
  // screens/REPL.tsx:1318). The stream consumer keeps setting state on
  // every SSE delta, but the conversation renders against a deferred
  // snapshot so React's concurrent scheduler can yield the main thread
  // back to the EventSource callback when deltas arrive faster than the
  // component can re-render. No hand-written RAF batching required —
  // React catches the deferred values up automatically when the flood
  // slows down. Keeps the partials map and messages list in sync for
  // the renderer while letting the stream breathe.
  const deferredMessages = useDeferredValue(messages);
  const deferredPartials = useDeferredValue(partials);
  const deferredToolInputPartials = useDeferredValue(toolInputPartials);

  // Flattened DelegationTask list for the right-rail TaskPanel. We run
  // stitchLeadMessages here on the live (non-deferred) messages so the
  // sidebar updates as close to real-time as possible — unlike the
  // conversation thread, the task panel isn't render-heavy enough to
  // need backpressure. Pulled across ALL session groups (not just the
  // one currently selected), so the panel stays useful while the user
  // is viewing older history.
  const allDelegationTasks = useMemo<DelegationTask[]>(() => {
    const nodes = stitchLeadMessages(messages, taskLookup, partials);
    const out: DelegationTask[] = [];
    for (const n of nodes) {
      if (n.kind === 'lead') {
        for (const d of n.delegation) out.push(d);
      }
    }
    return out;
  }, [messages, taskLookup, partials]);

  // Jump-to-task: single-click from the right-rail Task panel must
  // (a) switch the active run if the target lives elsewhere,
  // (b) scroll the matching SubtaskCard into view,
  // (c) fire `sf:task-focus` so the card force-expands.
  //
  // Cross-session path: set `pendingFocusMessageId` + `selectedRunId`.
  // Conversation reads `focusPendingMessageId` in its layout effect
  // and calls `unstick()` instead of `jumpToBottom()` so the
  // ResizeObserver doesn't pin back to the tail once the new
  // session's content measures. The `pendingFocusMessageId` effect
  // below then performs the scroll + pulse once the new cards are in
  // the DOM and clears the flag.
  //
  // Same-session path: the target card is already rendered, so we
  // can scroll + dispatch directly without a render round-trip.
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
      if (runId && runId !== selectedRunId) {
        setPendingFocusMessageId(messageId);
        setSelectedRunId(runId);
        return;
      }
      focusCardNow(messageId);
    },
    [selectedRunId, focusCardNow],
  );

  // After a cross-session jump the new SubtaskCards aren't in the DOM
  // until React commits + the layout effect in Conversation runs
  // (which un-sticks the scroll). Use a double rAF so this effect
  // fires after both commit + first paint, then scroll + dispatch
  // the expand event. The flag is cleared last so Conversation can
  // resume normal jump-to-tail behaviour on the next session switch.
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

  // Derive a per-run title from the first `user_prompt` message attributed
  // to that run. Truncated to 60 chars so it fits the session row. Upgrades
  // live via SSE: when a freshly-created session's first prompt lands, the
  // title pops in without a refetch.
  const titleByRunId = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of messages) {
      if (m.type !== 'user_prompt') continue;
      if (!m.runId) continue;
      if (map.has(m.runId)) continue;
      const raw = (m.content ?? '').trim().replace(/\s+/g, ' ');
      if (!raw) continue;
      map.set(m.runId, raw.length > 60 ? `${raw.slice(0, 60).trimEnd()}…` : raw);
    }
    return map;
  }, [messages]);

  const sessionListWithTitles = useMemo<readonly SessionMeta[]>(
    () =>
      sessionList.map((s) => ({
        ...s,
        title: titleByRunId.get(s.id) ?? s.title ?? null,
      })),
    [sessionList, titleByRunId],
  );

  // SSE-driven run status reconciliation. When a `completion` / `error`
  // message arrives for a known runId, flip that run (and matching session)
  // to the terminal status locally so the typing indicator clears without
  // waiting for a page refresh or refetch. First matching terminal message
  // wins — subsequent completions for the same runId are no-ops.
  useEffect(() => {
    const terminal = new Map<
      string,
      { status: 'completed' | 'failed' | 'cancelled'; at: string }
    >();
    for (const m of messages) {
      if (!m.runId) continue;
      if (terminal.has(m.runId)) continue;
      if (m.type === 'completion') {
        terminal.set(m.runId, { status: 'completed', at: m.createdAt });
      } else if (m.type === 'error') {
        // Worker stamps `metadata.cancelled = true` on the terminal
        // error it publishes when a user-initiated cancel unwinds the
        // run — distinguish so the session rail renders muted instead
        // of red.
        const meta = m.metadata;
        const isCancelled =
          !!meta && (meta as Record<string, unknown>)['cancelled'] === true;
        terminal.set(m.runId, {
          status: isCancelled ? 'cancelled' : 'failed',
          at: m.createdAt,
        });
      }
    }
    if (terminal.size === 0) return;

    setRunLookupState((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const [runId, t] of terminal) {
        const existing = next.get(runId);
        if (!existing) continue;
        if (existing.status === t.status) continue;
        if (
          existing.status === 'completed' ||
          existing.status === 'failed' ||
          existing.status === 'cancelled'
        ) {
          continue;
        }
        next.set(runId, {
          ...existing,
          status: t.status,
          completedAt: existing.completedAt ?? t.at,
        });
        changed = true;
      }
      return changed ? next : prev;
    });

    setSessionList((prev) => {
      let changed = false;
      const next = prev.map((s) => {
        const t = terminal.get(s.id);
        if (!t) return s;
        if (s.status === t.status) return s;
        if (
          s.status === 'completed' ||
          s.status === 'failed' ||
          s.status === 'cancelled'
        ) {
          return s;
        }
        changed = true;
        return {
          ...s,
          status: t.status,
          completedAt: s.completedAt ?? t.at,
        };
      });
      return changed ? next : prev;
    });
  }, [messages]);

  // If the parent ever re-renders with a fresh `sessions` prop (e.g. post-SSR
  // hydration or a navigation refetch), reconcile by merging — server rows
  // win on `id`, but any locally-optimistic row not yet reflected upstream
  // stays visible.
  useEffect(() => {
    if (!sessions) return;
    setSessionList((prev) => {
      const next = new Map<string, SessionMeta>();
      for (const s of prev) next.set(s.id, s);
      for (const s of sessions) next.set(s.id, s);
      return Array.from(next.values());
    });
  }, [sessions]);

  useEffect(() => {
    if (!runLookup) return;
    setRunLookupState((prev) => {
      const next = new Map<string, TeamRunMeta>(prev);
      for (const [id, run] of runLookup) next.set(id, run);
      return next;
    });
  }, [runLookup]);

  const handleSelectSession = useCallback(
    (runId: string | null) => {
      setSelectedRunId(runId);
      // Navigating away from an unbriefed draft tosses it — the rail would
      // otherwise accumulate phantom placeholders every time the user
      // changes their mind.
      if (draftSessionId && runId !== draftSessionId) {
        setSessionList((prev) => prev.filter((s) => s.id !== draftSessionId));
        setDraftSessionId(null);
      }
    },
    [draftSessionId],
  );

  const handleDraftCreated = useCallback(({ draftId }: NewSessionResult) => {
    const startedAt = new Date().toISOString();
    const draftRow: SessionMeta = {
      id: draftId,
      trigger: 'manual',
      goal: null,
      status: 'draft',
      startedAt,
      completedAt: null,
      totalTurns: 0,
      title: null,
    };
    setSessionList((prev) => {
      // Only one draft at a time — previous draft gets replaced.
      const withoutPrevDraft = prev.filter((s) => s.status !== 'draft');
      return [draftRow, ...withoutPrevDraft];
    });
    setDraftSessionId(draftId);
    setSelectedRunId(draftId);
    requestAnimationFrame(() => composerRef.current?.focus());
  }, []);

  const insertOptimisticRun = useCallback((result: {
    runId: string;
    alreadyRunning: boolean;
  }) => {
    setSelectedRunId(result.runId);
    requestAnimationFrame(() => composerRef.current?.focus());
    if (result.alreadyRunning) return;

    const nowIso = new Date().toISOString();
    const optimistic: SessionMeta = {
      id: result.runId,
      trigger: 'manual',
      goal: null,
      status: 'running',
      startedAt: nowIso,
      completedAt: null,
      totalTurns: 0,
      title: null,
    };
    setSessionList((prev) => {
      if (prev.some((s) => s.id === result.runId)) return prev;
      return [optimistic, ...prev];
    });
    const optimisticRun: TeamRunMeta = {
      id: result.runId,
      trigger: 'manual',
      goal: null,
      status: 'running',
      startedAt: nowIso,
      completedAt: null,
    };
    setRunLookupState((prev) => {
      if (prev.has(result.runId)) return prev;
      const next = new Map<string, TeamRunMeta>(prev);
      next.set(result.runId, optimisticRun);
      return next;
    });
  }, []);

  const { start: startNewSession, creating: creatingSession } = useNewSession({
    onCreated: handleDraftCreated,
  });

  const handleComposerSent = useCallback(
    (result: StickyComposerSendResult) => {
      if (!result.runId) return;
      // If the user was writing in a draft session, the composer's send
      // promotes it: drop the placeholder row and install the real run in
      // its place. The rail momentarily ordering stays stable because the
      // new optimistic row is also prepended.
      if (draftSessionId) {
        setSessionList((prev) => prev.filter((s) => s.id !== draftSessionId));
        setDraftSessionId(null);
      }
      insertOptimisticRun({
        runId: result.runId,
        alreadyRunning: result.alreadyRunning,
      });
    },
    [draftSessionId, insertOptimisticRun],
  );

  // Defensive: if the selected run vanished from the list (deletion, stale
  // client state), fall back to the ALL view instead of rendering a dead
  // selection that no session row can highlight.
  useEffect(() => {
    if (selectedRunId === null) return;
    const stillThere = sessionList.some((s) => s.id === selectedRunId);
    if (!stillThere) setSelectedRunId(null);
  }, [selectedRunId, sessionList]);

  // `isLive` from SSR is frozen at page render — when a run finishes
  // client-side (via SSE terminal reconciliation) it never flips back
  // false, so the + New session button would be disabled forever. Derive
  // a live version from the current session list instead. Pending/running
  // session rows count; drafts don't (they're client-only placeholders).
  const anySessionRunning = useMemo(
    () =>
      sessionList.some(
        (s) => s.status === 'running' || s.status === 'pending',
      ),
    [sessionList],
  );
  const canCreateSession = !anySessionRunning && !creatingSession;

  // The composer's Stop button shows only when the selected session is
  // the one currently running — otherwise the button would target a
  // session the user can't see, which is confusing. Draft sessions are
  // excluded by the status check (they're client-only placeholders).
  const cancellableRunId = useMemo<string | null>(() => {
    if (!selectedRunId) return null;
    const selected = sessionList.find((s) => s.id === selectedRunId);
    if (!selected) return null;
    return selected.status === 'running' || selected.status === 'pending'
      ? selected.id
      : null;
  }, [selectedRunId, sessionList]);

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

  // Per-subtask cancel — fires against the task-scoped endpoint. The
  // worker publishes a synthetic tool_result with metadata.cancelled so
  // the SubtaskCard flips to CANCELLED on the next SSE tick without
  // waiting for a refetch.
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
              : `Couldn't cancel subtask: ${
                  detail.error ?? `HTTP ${res.status}`
                }`,
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

  // Per-subtask retry — spawns a fresh independent run with the same
  // subagent + prompt. We jump the session rail to the new run so the
  // user lands where the action actually shipped.
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
              : `Couldn't retry subtask: ${
                  detail.error ?? `HTTP ${res.status}`
                }`,
            'error',
          );
          return;
        }
        const body = (await res.json().catch(() => ({}))) as {
          runId?: string;
          alreadyRunning?: boolean;
        };
        if (body.runId) {
          insertOptimisticRun({
            runId: body.runId,
            alreadyRunning: !!body.alreadyRunning,
          });
          toast('Retrying subtask in a new session.', 'success');
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
    [toast, insertOptimisticRun],
  );

  const allMembers = useMemo<TeamDeskMember[]>(
    () => (teamLead ? [teamLead, ...specialists] : [...specialists]),
    [teamLead, specialists],
  );

  const memberLookup = useMemo(() => {
    const map = new Map<string, TeamDeskMember>();
    for (const m of allMembers) map.set(m.id, m);
    return map;
  }, [allMembers]);

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

  // Viewport-bounded shell. The team desk fits the app canvas (below the
  // 56px TopNav) and scroll happens per-column inside the grid instead of
  // the whole page rolling up. That's what lets the chat column have its
  // own thin scrollbar on the right — Claude-style — while the rails and
  // composer stay put.
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

  // Left-rail / conversation still accept `activeMemberId` + `onSelect`
  // props from an older workspace-panel flow. Nothing selects agents
  // anymore (Phase 5 deleted the panel), but the prop signature lives
  // on — Phase 6's TaskPanel / future use could put it back. Stub with
  // a no-op so callers needn't know which state world they're in.
  const noopSelectMember = useCallback((_: string) => {
    /* workspace deleted — members are no longer selectable here */
  }, []);

  // Each column owns its own overflow so content never breaks out into the
  // page scroll. The center column carries the primary scrollbar; the
  // rails only scroll internally when their content runs long.
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
            sessions={sessionListWithTitles}
            selectedRunId={selectedRunId}
            onSelectSession={handleSelectSession}
            onNewSession={startNewSession}
            canCreateSession={canCreateSession}
            creatingSession={creatingSession}
          />
        </div>

        <div className="ai-team-center" style={centerCol}>
          <Conversation
            members={conversationMembers}
            coordinatorId={coordinatorId}
            messages={deferredMessages}
            partials={deferredPartials}
            toolInputPartials={deferredToolInputPartials}
            taskLookup={taskLookup}
            runLookup={runLookupState}
            activeMemberId={null}
            onSelectMember={noopSelectMember}
            selectedRunId={selectedRunId}
            isLive={anySessionRunning}
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
      />

      <style jsx global>{`
        /*
         * Fixed-viewport layout: the team desk holds everything in one
         * screen and each column (left rail / conversation / right rail)
         * owns its own scroll region. The left rail's sticky / max-height
         * from the old page-scroll world is overridden here so it fills
         * its grid cell cleanly.
         */
        .ai-team-left > aside {
          position: relative !important;
          top: auto !important;
          max-height: none !important;
          height: 100%;
        }

        /*
         * Claude-style thin scrollbar applied to every scroll region on
         * the team desk — the conversation column, the rail interiors,
         * and the right-column overflow. Subtle by default (12% alpha),
         * fades in on hover. Using specific selectors keeps this from
         * leaking into other app surfaces that want the native bar.
         */
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
        /*
         * Below 1024px the right rail wraps to a new row, so a single
         * fixed-viewport shell can't contain it anymore. Fall back to
         * page-scroll: root loses its height cap, columns stop
         * scrolling internally, and the browser handles overflow.
         */
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
