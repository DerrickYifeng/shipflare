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
  type PartialLeadMessage,
  type TeamActivityMessage,
} from '@/hooks/use-team-events';
import { useToast } from '@/components/ui/toast';
import { LeftRail, type LeftRailMember } from './left-rail';
import {
  Conversation,
  type ConversationMember,
  type ConversationScrollHandle,
} from './conversation';
import { TaskPanel } from './task-panel';
import {
  StickyComposer,
  type StickyComposerHandle,
  type StickyComposerSendResult,
} from './sticky-composer';
import { StatusBanner } from './status-banner';
import { OnboardingBanner } from './onboarding-banner';
// A2's bottom rail was removed (2026-05-13): the right Tasks panel already
// surfaces running teammates with live activity, and a second surface at the
// bottom was redundant. Click-to-expand on the panel replaces the rail.
import {
  applyStatusChanges,
  stitchLeadMessages,
  type AgentRunStatus,
  type AgentRunStatusMap,
  type DelegationTask,
  type TeamRunLookup,
  type TeamRunMeta,
} from './conversation-reducer';
import type { ConversationMeta } from './conversation-meta';
import { useNewConversation } from './use-new-conversation';
import {
  StreamingProvider,
  useStreamingDispatch,
} from './streaming-context';

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
  activeRunId: string | null;
  activeRunStartedAt: string | null;
  isLive: boolean;
  leadMessage: string;
  draftsInFlight: number;
  inReview: number;
  approvedReady: number;
  turns: number;
  agentRunStatus?: AgentRunStatusMap;
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
/**
 * Inner body. Wrapped by `TeamDesk` (below) in `<StreamingProvider>` so
 * that `useStreamingDispatch()` resolves inside the dispatch-piping
 * effect. Splitting the function lets the provider sit ABOVE every
 * consumer (`<Conversation>` + leaves) without changing the public
 * signature.
 */
function TeamDeskInner({
  teamId,
  coordinatorId,
  fromOnboarding = false,
  teamLead,
  specialists,
  initialMessages,
  activeRunId,
  activeRunStartedAt,
  isLive,
  leadMessage,
  draftsInFlight,
  inReview,
  approvedReady,
  agentRunStatus,
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

  // Per-conversation message fetches. When the user clicks a conversation,
  // we load its latest window here; SSE messages are merged on top via
  // `allMessages`. The window expands when the user scrolls to the top of
  // the thread (see `handleLoadOlder` below).
  const [fetchedMessages, setFetchedMessages] = useState<
    TeamActivityMessage[]
  >([]);
  // Per-conversation pagination state — the oldest message timestamp we've
  // fetched so far (cursor) and whether the server says there are more
  // older rows. `undefined` means "never loaded" — that's how the initial
  // fetch effect knows to fire.
  type ConvWindow = {
    oldestAt: string | null;
    hasMore: boolean;
    loadingOlder: boolean;
  };
  const [convWindowMap, setConvWindowMap] = useState<
    Record<string, ConvWindow>
  >({});
  // In-flight guard so a slow initial fetch doesn't get fired twice if
  // the user hops between conversations (and so load-older can't stack).
  const inFlightFetchRef = useRef<Set<string>>(new Set());

  const composerRef = useRef<StickyComposerHandle | null>(null);
  // Imperative handle into `<Conversation>` — lets `focusCardNow` mount
  // the target row when the conversation is virtualized BEFORE querying
  // for `subtask-card-${messageId}` and calling `scrollIntoView`. Without
  // this, rail clicks on subagents whose card sits outside the
  // virtualizer's visible window silently no-op (querySelector returns
  // null for unmounted virtual rows). Null in non-virtualized mode (the
  // bridge in Conversation makes `scrollToId` a no-op there since every
  // row is already mounted).
  const conversationScrollHandleRef = useRef<ConversationScrollHandle | null>(
    null,
  );

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

  // Pipe streaming bytes from `useTeamEvents`'s partial maps into the
  // per-tree `StreamingStore` so leaves can subscribe per-messageId via
  // `useStreamingPartial` without re-rendering on every token. A2 will
  // drop the partials prop entirely once the bottom rail takes over
  // placeholder rendering; for now this runs alongside the existing
  // prop path so the UI cannot regress.
  useStreamingPartialPipe(partials, toolInputPartials);

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
  // Initial fetch: load the latest window for this conversation. We pull
  // the most recent 100 messages and let the user scroll up to load older
  // batches via `handleLoadOlder` below. This replaces the previous
  // "fetch ALL messages on click" behaviour, which was pleasant for short
  // conversations but melted memory on multi-thousand-row threads.
  useEffect(() => {
    if (!selectedConversationId) return;
    const cid = selectedConversationId;
    if (convWindowMap[cid]) return; // already loaded once
    if (inFlightFetchRef.current.has(cid)) return;
    inFlightFetchRef.current.add(cid);
    let cancelled = false;

    fetch(
      `/api/team/conversations/${encodeURIComponent(cid)}/messages?limit=100`,
      { credentials: 'same-origin' },
    )
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
        hasMore?: boolean;
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
        setConvWindowMap((prev) => ({
          ...prev,
          [cid]: {
            // Server returns ASC, so messages[0] is the oldest in this batch.
            oldestAt: mapped[0]?.createdAt ?? null,
            hasMore: Boolean(body.hasMore),
            loadingOlder: false,
          },
        }));
      })
      .catch((err) => {
        // Don't pin convWindowMap so a retry click can re-fetch.
        toast(
          err instanceof Error
            ? `Couldn't load conversation history: ${err.message}`
            : 'Network error loading conversation history.',
          'error',
        );
      })
      .finally(() => {
        inFlightFetchRef.current.delete(cid);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedConversationId, teamId, toast, convWindowMap]);

  // ---------- Load older messages on scroll-up ----------
  // Called by Conversation when the user scrolls within ~100px of the
  // top. Pulls the next 100 rows older than `oldestAt` and prepends them
  // into `fetchedMessages`. The conversation component captures the pre-
  // load scroll metrics so the visible cursor doesn't jump after the
  // prepend lands. This callback's identity is stable across renders.
  const handleLoadOlder = useCallback(
    (cid: string): void => {
      const win = convWindowMap[cid];
      if (!win || !win.hasMore || !win.oldestAt) return;
      if (win.loadingOlder) return;
      if (inFlightFetchRef.current.has(`older:${cid}`)) return;
      inFlightFetchRef.current.add(`older:${cid}`);

      setConvWindowMap((prev) =>
        prev[cid]
          ? { ...prev, [cid]: { ...prev[cid], loadingOlder: true } }
          : prev,
      );

      fetch(
        `/api/team/conversations/${encodeURIComponent(
          cid,
        )}/messages?limit=100&before=${encodeURIComponent(win.oldestAt)}`,
        { credentials: 'same-origin' },
      )
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
          hasMore?: boolean;
        }) => {
          if (!Array.isArray(body.messages)) return;
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
          if (mapped.length > 0) {
            setFetchedMessages((prev) => [...prev, ...mapped]);
          }
          setConvWindowMap((prev) => {
            const cur = prev[cid];
            if (!cur) return prev;
            const newOldest =
              mapped.length > 0 ? mapped[0].createdAt : cur.oldestAt;
            return {
              ...prev,
              [cid]: {
                oldestAt: newOldest,
                hasMore: Boolean(body.hasMore),
                loadingOlder: false,
              },
            };
          });
        })
        .catch((err) => {
          setConvWindowMap((prev) =>
            prev[cid]
              ? { ...prev, [cid]: { ...prev[cid], loadingOlder: false } }
              : prev,
          );
          toast(
            err instanceof Error
              ? `Couldn't load older messages: ${err.message}`
              : 'Network error loading older messages.',
            'error',
          );
        })
        .finally(() => {
          inFlightFetchRef.current.delete(`older:${cid}`);
        });
    },
    [convWindowMap, teamId, toast],
  );

  // ---------- Sidebar reconciliation ----------
  // Hydrate from server props.
  useEffect(() => {
    if (!conversations) return;
    const snapshot = conversations;
    queueMicrotask(() =>
      setConversationList((prev) => {
        const next = new Map<string, ConversationMeta>();
        for (const c of prev) next.set(c.id, c);
        for (const c of snapshot) next.set(c.id, c);
        return Array.from(next.values()).sort((a, b) =>
          a.updatedAt > b.updatedAt ? -1 : 1,
        );
      }),
    );
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

    const byConv = latestByConv;
    queueMicrotask(() =>
      setConversationList((prev) => {
        let changed = false;
        const next = prev.map((c) => {
          const latest = byConv.get(c.id);
          if (!latest) return c;
          if (latest <= c.updatedAt) return c;
          changed = true;
          return { ...c, updatedAt: latest };
        });
        if (!changed) return prev;
        return [...next].sort((a, b) => (a.updatedAt > b.updatedAt ? -1 : 1));
      }),
    );
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

  // Merge SSE-delivered `agent_status_change` events on top of the
  // SSR-seeded `agentRunStatus` once per render so every downstream
  // consumer (rail, conversation reducer call sites that pass their own
  // map, etc.) sees the same up-to-date view. `agentRunStatus` (prop) is
  // frozen at page-load time; `liveAgentRunStatus` IS the fresh map.
  // This was the bug: the rail used to read from `agentRunStatus`
  // directly and never saw the queued→running transition.
  const liveAgentRunStatus = useMemo(
    () => applyStatusChanges(liveMessages, agentRunStatus ?? new Map()),
    [liveMessages, agentRunStatus],
  );

  // ---------- Delegation tasks (task panel, global view) ----------
  const allDelegationTasks = useMemo<DelegationTask[]>(() => {
    const nodes = stitchLeadMessages(liveMessages, agentRunStatus, partials);
    const out: DelegationTask[] = [];
    for (const n of nodes) {
      if (n.kind === 'lead') {
        for (const d of n.delegation) out.push(d);
      }
    }
    return out;
  }, [liveMessages, agentRunStatus, partials]);

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
    // Notify subscribers (LeadMessage / DelegationCard) so they can
    // expand or auto-scroll their internal panes. Fire-and-forget; no
    // dependency on whether the target card mounts.
    window.dispatchEvent(
      new CustomEvent('sf:task-focus', { detail: { messageId } }),
    );

    // Phase 1: ensure the row is in the DOM. In virtualized mode,
    // off-window rows are unmounted — querySelector would return null
    // and the jump would silently no-op. `scrollToId` calls into the
    // virtualizer's scrollToIndex and the next animation frame is
    // enough for the row to mount + measure. In non-virtualized mode
    // `scrollToId` is a no-op (every row is already mounted) and the
    // double-RAF is harmless overhead measured in tens of micros.
    const handle = conversationScrollHandleRef.current;
    if (handle) handle.scrollToId(messageId);

    // Phase 2: find the inner SubtaskCard (which the row's renderer
    // creates) and run the fine-grained centering + pulse animation.
    // Wrapped in a double-RAF because the virtualizer may need one
    // frame to mount the row and a second for the measureElement
    // ResizeObserver to settle the row's final height. The animation
    // call is wrapped in a null-check so legacy/raw runs without a
    // SubtaskCard still trigger the sf:task-focus event above without
    // a console error.
    let frame1 = 0;
    let frame2 = 0;
    frame1 = requestAnimationFrame(() => {
      frame2 = requestAnimationFrame(() => {
        const el = document.querySelector<HTMLElement>(
          `[data-testid="subtask-card-${messageId}"]`,
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
      });
    });
    // Best-effort: the closure exits before the frames fire so we
    // can't return a teardown directly, but reassigning the timers
    // through let-bindings keeps them GC-able once the frames resolve.
    void frame1;
    void frame2;
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

  // Rail click → scroll the matching SubtaskCard into view + pulse it,
  // matching the engine TaskListV2 pattern ("tap a task → jump to it").
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
    async (agentId: string) => {
      try {
        const res = await fetch(
          `/api/team/agent/${encodeURIComponent(agentId)}/cancel`,
          { method: 'POST' },
        );
        if (!res.ok && res.status !== 200) {
          const detail = (await res
            .json()
            .catch(() => ({ error: `HTTP ${res.status}` }))) as {
            error?: string;
          };
          toast(
            detail.error === 'agent_not_found'
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
            agentRunStatus={agentRunStatus}
            runLookup={threadRunLookup}
            activeMemberId={null}
            onSelectMember={noopSelectMember}
            isLive={threadIsLive}
            onPrefillComposer={prefillComposer}
            onFocusComposer={focusComposer}
            focusPendingMessageId={pendingFocusMessageId}
            // Base reservation: composer (~96px) + outer padding (~20px) +
            // breathing room above the keyboard so the last message clears
            // the sticky composer footer. The A2 bottom rail used to bump
            // this; removed 2026-05-13 along with the rail itself.
            bottomReservation={180}
            hasOlder={
              selectedConversationId
                ? convWindowMap[selectedConversationId]?.hasMore ?? false
                : false
            }
            loadingOlder={
              selectedConversationId
                ? convWindowMap[selectedConversationId]?.loadingOlder ?? false
                : false
            }
            onLoadOlder={
              selectedConversationId
                ? () => handleLoadOlder(selectedConversationId)
                : undefined
            }
            scrollHandleRef={conversationScrollHandleRef}
          />
        </div>

        <div className="ai-team-right" style={rightRail}>
          <TaskPanel
            tasks={allDelegationTasks}
            liveAgentRunStatus={liveAgentRunStatus}
            onJumpToTask={handleJumpToTask}
            onCancelTask={handleCancelTask}
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

/**
 * Public wrapper. Hosts the per-tree `<StreamingProvider>` so leaves
 * inside `<Conversation>` (LeadMessage, DelegationCard) can subscribe to
 * streaming-partial state without forcing the conversation reducer to
 * re-run on every token.
 */
export function TeamDesk(props: TeamDeskProps) {
  return (
    <StreamingProvider>
      <TeamDeskInner {...props} />
    </StreamingProvider>
  );
}

/**
 * Diff `partials` / `toolInputPartials` from `useTeamEvents` against the
 * previous render's snapshot. Forwards the suffix of newly-arrived bytes
 * to the streaming dispatch. When a partial vanishes from the map (final
 * `agent_text` landed, or stall sweep dropped it), call the matching
 * finalizer so any subscribed leaf clears its live-text override.
 *
 * Partials and tool-inputs are routed through independent finalize calls
 * so their keyspaces stay separated even if a messageId and a toolUseId
 * happen to collide on the same string (see `streaming-context.tsx`).
 *
 * Lives inside `<StreamingProvider>` so `useStreamingDispatch()` resolves.
 * The diff lives on a ref (not state) because we never want this effect
 * itself to trigger a re-render of `TeamDeskInner`.
 */
function useStreamingPartialPipe(
  partials: ReadonlyMap<string, PartialLeadMessage>,
  toolInputPartials: ReadonlyMap<string, string>,
): void {
  const dispatch = useStreamingDispatch();
  const prevPartialTextRef = useRef<Map<string, string>>(new Map());
  const prevToolInputRef = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    const prev = prevPartialTextRef.current;
    const seen = new Set<string>();
    for (const [id, p] of partials) {
      seen.add(id);
      const prior = prev.get(id) ?? '';
      const next = p.content;
      if (next.length > prior.length && next.startsWith(prior)) {
        dispatch.appendDelta(id, next.slice(prior.length));
      } else if (next !== prior) {
        // Non-monotonic edit (rare; happens on reconnect when the hook
        // wipes its partials map — see `use-team-events.ts`'s `connected`
        // branch). Replay the whole content as a single delta after
        // finalizing the stale entry.
        dispatch.finalizePartial(id);
        if (next.length > 0) dispatch.appendDelta(id, next);
      }
    }
    // Anything that was in the previous snapshot but isn't now → drop.
    for (const id of prev.keys()) {
      if (!seen.has(id)) dispatch.finalizePartial(id);
    }
    // Replace snapshot with the new view (content snapshot only).
    const nextSnap = new Map<string, string>();
    for (const [id, p] of partials) nextSnap.set(id, p.content);
    prevPartialTextRef.current = nextSnap;
  }, [partials, dispatch]);

  useEffect(() => {
    const prev = prevToolInputRef.current;
    const seen = new Set<string>();
    for (const [id, content] of toolInputPartials) {
      seen.add(id);
      const prior = prev.get(id) ?? '';
      if (content.length > prior.length && content.startsWith(prior)) {
        dispatch.appendToolInput(id, content.slice(prior.length));
      } else if (content !== prior) {
        dispatch.finalizeToolInput(id);
        if (content.length > 0) dispatch.appendToolInput(id, content);
      }
    }
    for (const id of prev.keys()) {
      if (!seen.has(id)) dispatch.finalizeToolInput(id);
    }
    const nextSnap = new Map<string, string>();
    for (const [id, content] of toolInputPartials) nextSnap.set(id, content);
    prevToolInputRef.current = nextSnap;
  }, [toolInputPartials, dispatch]);
}
