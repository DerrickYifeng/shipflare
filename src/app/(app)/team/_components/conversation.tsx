'use client';

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react';
import type {
  PartialLeadMessage,
  TeamActivityMessage,
} from '@/hooks/use-team-events';
import { UserMessage } from './user-message';
import { LeadMessage } from './lead-message';
import { DelegationCard, type DelegationCardMember } from './delegation-card';
import { SessionDivider } from './session-divider';
import { TypingIndicator } from './typing-indicator';
import { ToolActivity } from './tool-activity';
import { useAutoScroll } from './use-auto-scroll';
import {
  VirtualConversation,
  type VirtualConversationHandle,
} from './virtual-conversation';
import { EmptyConversation } from './empty-conversation';
import {
  groupByRun,
  stitchLeadMessages,
  type ActivityNode,
  type AgentRunStatusMap,
  type ConversationNode,
  type LeadNode,
  type SessionGroup,
  type TeamRunLookup,
} from './conversation-reducer';

export interface ConversationMember {
  id: string;
  agentType: string;
  displayName: string;
}

export interface ConversationProps {
  members: readonly ConversationMember[];
  coordinatorId: string | null;
  messages: readonly TeamActivityMessage[];
  /**
   * In-flight streaming text keyed by messageId — each entry becomes a
   * LeadNode with `streaming: true` so the thread shows a breathing
   * indicator until the final `agent_text` lands and the partial is
   * dropped from the hook's state.
   */
  partials?: ReadonlyMap<string, PartialLeadMessage>;
  /**
   * In-flight tool-input JSON keyed by toolUseId. Used by the dispatch
   * card to show a loading spinner for any subtask whose Task call
   * hasn't finished streaming its arguments.
   */
  toolInputPartials?: ReadonlyMap<string, string>;
  agentRunStatus?: AgentRunStatusMap;
  runLookup?: TeamRunLookup;
  activeMemberId: string | null;
  onSelectMember: (memberId: string) => void;
  /** True when any run is running — drives the typing indicator. */
  isLive?: boolean;
  /**
   * Chip callbacks in the empty state — prefill & focus the sticky composer.
   */
  onPrefillComposer?: (text: string) => void;
  onFocusComposer?: () => void;
  /**
   * Non-null when the right-rail Task panel is requesting a jump to
   * a specific SubtaskCard on the next session-switch render. When
   * set, Conversation skips its normal "jump to tail" behaviour so
   * TeamDesk's focus effect can take over without fighting the
   * auto-scroll pin.
   */
  focusPendingMessageId?: string | null;
  /**
   * Set of `agent_runs.id` values currently surfaced in the bottom rail
   * (A2). When a DelegationTask's `agentId` is in this set, the
   * conversation-level DelegationCard collapses its pulsing in-flight
   * chrome to a thin "see in rail" hint so the teammate doesn't appear
   * twice on screen. Terminal teammates fall out of the set and the
   * card re-expands with its final summary.
   */
  activeSubagentIds?: ReadonlySet<string>;
  /**
   * Pixel reservation at the bottom of the scroll container. Defaults
   * to `DEFAULT_BOTTOM_RESERVATION` (sized for the composer card +
   * outer padding + a comfort buffer). When the A2 bottom rail is
   * non-empty, the caller bumps this so the last messages stay
   * readable above the rail's translucent backdrop instead of being
   * obscured by it.
   */
  bottomReservation?: number;
  /**
   * Older-history pagination. When `hasOlder` is true and the user
   * scrolls within ~100px of the top of the thread, `onLoadOlder` is
   * invoked. The parent (TeamDesk) flips `loadingOlder` while the
   * fetch is in flight, and prepends the new batch to `messages` —
   * Conversation's layout effect then restores scroll position so
   * the visible cursor doesn't jump.
   */
  hasOlder?: boolean;
  loadingOlder?: boolean;
  onLoadOlder?: () => void;
  /**
   * Optional ref the conversation populates with a
   * `ConversationScrollHandle` so the parent's jump-to-task flow can
   * ensure a target row is mounted before running `scrollIntoView`. In
   * non-virtualized mode `scrollToId` is a no-op (all rows are always
   * mounted, so `document.querySelector` already works). In virtualized
   * mode it forwards to `VirtualConversation.scrollToId` which calls
   * `virtualizer.scrollToIndex` — fixing the silent failure where
   * jump-to-task on an off-screen virtualized row returned null from
   * the parent's querySelector.
   */
  scrollHandleRef?: RefObject<ConversationScrollHandle | null>;
}

/**
 * Imperative handle exposed via `scrollHandleRef`. The single method
 * intentionally accepts a node id (DelegationTask.messageId in the
 * common case) rather than an index, so callers don't need to know
 * whether the conversation is currently virtualized.
 */
export interface ConversationScrollHandle {
  scrollToId(id: string): void;
}

/**
 * Sized for the typical (collapsed) composer: 20 bottom inset +
 * ~120 card + 40 fade ≈ 180. Bumped by the caller when the A2
 * bottom rail is present.
 */
const DEFAULT_BOTTOM_RESERVATION = 180;

const THREAD_MAX_WIDTH = 740;

/**
 * Total flat-node count (across all session groups) above which we swap
 * to a windowed renderer (`VirtualConversation`). Small sessions stay on
 * the simple render path — no virtualization tax for the common case.
 * Long discovery sessions (hundreds of nodes) get DOM-windowed so each
 * stream tick doesn't re-render every prior node.
 *
 * Tuned to ~50 so a typical 4-5 turn coordinator conversation
 * (lead+activity rows easily run to 40-60 nodes) is right at the
 * threshold, above which we expect things to get sluggish without
 * windowing. Bump if you measure a different inflection point.
 */
const VIRTUALIZATION_NODE_THRESHOLD = 50;

/**
 * Center column conversation. Receives the full message stream (from the
 * TeamDesk shell's shared `useTeamEvents` subscription), stitches adjacent
 * lead text + Task tool_calls into one node, and renders:
 *  - `user` nodes as blue right-aligned bubbles
 *  - `lead` nodes as left-rail lead rows with an optional delegation card
 *  - `activity` nodes as compact inline tool-use rows
 *  - `raw` nodes are skipped for this v1 (tool_results, thinking, etc.).
 */
export function Conversation({
  members,
  coordinatorId,
  messages,
  partials,
  toolInputPartials,
  agentRunStatus,
  runLookup,
  activeMemberId,
  onSelectMember,
  isLive = false,
  onPrefillComposer,
  onFocusComposer,
  focusPendingMessageId = null,
  activeSubagentIds,
  bottomReservation = DEFAULT_BOTTOM_RESERVATION,
  hasOlder = false,
  loadingOlder = false,
  onLoadOlder,
  scrollHandleRef,
}: ConversationProps) {
  const memberLookup = useMemo(() => {
    const map = new Map<string, DelegationCardMember>();
    for (const m of members) {
      map.set(m.id, { id: m.id, agentType: m.agentType, displayName: m.displayName });
    }
    return map;
  }, [members]);

  const nodes: ConversationNode[] = useMemo(
    () => stitchLeadMessages(messages, agentRunStatus, partials),
    [messages, agentRunStatus, partials],
  );

  const groups: SessionGroup[] = useMemo(
    () => groupByRun(nodes, runLookup),
    [nodes, runLookup],
  );

  // The caller (TeamDesk) pre-filters `messages` to the selected
  // conversation. This component just renders every group it receives
  // — no visibility decisions here. Empty thread → welcome screen.
  const visibleGroups: SessionGroup[] = groups;

  // Long sessions (> VIRTUALIZATION_NODE_THRESHOLD nodes) swap to a
  // windowed renderer (`<VirtualConversation>`). Computed up front so
  // the effects below can disable `loadOlder` while virtualized —
  // prepend-with-virtualization is a known follow-up gap (estimate-vs-
  // actual measurement delta breaks the anchor-restore math).
  const flatNodeCount = useMemo(
    () => visibleGroups.reduce((sum, g) => sum + g.nodes.length, 0),
    [visibleGroups],
  );
  const useVirtualized = flatNodeCount > VIRTUALIZATION_NODE_THRESHOLD;
  const effectiveHasOlder = useVirtualized ? false : hasOlder;
  const effectiveLoadingOlder = useVirtualized ? false : loadingOlder;

  // Decide whether to show the typing indicator. Shown when:
  // - a run is live, AND
  //   - the selected run's status is 'running', OR
  //   - (all view) any visible group belongs to a running run, OR
  //   - the last visible node is a user bubble with no reply yet.
  const showTyping = useMemo(() => {
    if (!isLive) return false;
    if (visibleGroups.length === 0) return false;
    const lastGroup = visibleGroups[visibleGroups.length - 1];
    const runIsRunning = lastGroup.run?.status === 'running';
    const lastNode = lastGroup.nodes[lastGroup.nodes.length - 1];
    const lastIsUser = lastNode?.kind === 'user';
    const lastIsPendingActivity =
      lastNode?.kind === 'activity' && !lastNode.complete;
    return runIsRunning || lastIsUser || lastIsPendingActivity;
  }, [isLive, visibleGroups]);

  // Scroll container and its direct child (the "content" element the
  // ResizeObserver watches for grow events). `useAutoScroll` pins the
  // container to the bottom on any content growth while the user is
  // "stuck" — switching sessions resets stickiness, new messages
  // re-stick.
  const threadRef = useRef<HTMLElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  // Imperative handle the virtualized renderer populates. Used below
  // by the `scrollHandleRef` bridge so callers (team-desk's
  // `focusCardNow`) can mount-then-scroll virtualized rows that
  // currently sit outside the window. Null when not virtualized.
  const virtualHandleRef = useRef<VirtualConversationHandle | null>(null);

  // Bridge parent's `scrollHandleRef` ↔ internal renderer. In
  // virtualized mode we forward to the virtualizer's scrollToIndex via
  // `virtualHandleRef`; in non-virtualized mode `scrollToId` is a no-op
  // because every row is already mounted (the caller's `querySelector +
  // scrollIntoView` already works without our help). We re-write the
  // handle on every render so toggling between virtualized/non-
  // virtualized while the parent's ref identity stays stable continues
  // to work without manual unsubscribe.
  useEffect(() => {
    if (!scrollHandleRef) return;
    scrollHandleRef.current = {
      scrollToId: (id: string): void => {
        if (useVirtualized) {
          virtualHandleRef.current?.scrollToId(id);
        }
        // Non-virtualized: caller's own scrollIntoView is sufficient.
      },
    };
    return () => {
      if (scrollHandleRef) scrollHandleRef.current = null;
    };
  }, [scrollHandleRef, useVirtualized]);

  const { paused, jumpToBottom, unstick } = useAutoScroll({
    containerRef: threadRef,
    contentRef,
  });

  // Session-switch pin: when `selectedRunId` changes the content is a
  // different conversation entirely, so jumping to the tail matches
  // ChatGPT/Claude muscle memory. `useLayoutEffect` runs after the new
  // nodes have committed to the DOM but before paint, so the jump is
  // invisible. `jumpToBottom` resets the stickiness ref so subsequent
  // streaming deltas continue to auto-follow.
  //
  // Exception: when the right-rail Task panel requested a jump to a
  // specific SubtaskCard, skip the tail-jump AND un-stick the
  // ResizeObserver so the target card stays in view once TeamDesk's
  // focus effect calls scrollIntoView.
  // Jump to the tail whenever the thread identity changes (first user
  // message's runId is a stable-enough proxy for "this is a new thread").
  // Exception: when the right-rail Task panel requested a jump to a
  // specific SubtaskCard, skip the tail-jump AND un-stick the
  // ResizeObserver so the target card stays in view.
  const firstRunId = visibleGroups[0]?.runId ?? null;
  useLayoutEffect(() => {
    if (focusPendingMessageId) {
      unstick();
      return;
    }
    jumpToBottom();
    // A conversation switch invalidates any pending older-load anchor —
    // dropping it here prevents the next layout effect from applying a
    // captured delta to the new conversation's container.
    pendingPrependRef.current = null;
  }, [firstRunId, jumpToBottom, unstick, focusPendingMessageId]);

  // ---------- Older-history pagination ----------
  // We capture the scroll metrics + the current top-of-list message id at
  // the moment the user triggers a load-older. After the prepend lands
  // (detected via messages[0]?.id changing in a layout effect below), we
  // restore `scrollTop` so the visible content doesn't jump upward by the
  // height of the new batch. Standard infinite-scroll-up anchor pattern.
  //
  // All four refs declared together up front so every effect below has a
  // resolved binding and `react-hooks/immutability` is satisfied.
  const pendingPrependRef = useRef<{
    scrollHeight: number;
    scrollTop: number;
    prevFirstId: string | null;
  } | null>(null);
  const hasOlderRef = useRef(hasOlder);
  const loadingOlderRef = useRef(loadingOlder);
  const messagesRef = useRef(messages);

  // Mirror the latest props onto refs in an effect (render-time `.current`
  // writes trip the react-hooks/immutability rule). Runs every render so
  // the scroll handler — registered once per onLoadOlder identity — always
  // sees fresh values without re-binding. Note: the virtualized branch
  // below writes the *effective* hasOlder (forced false while windowed)
  // here too so the scroll handler can't fire a load-older during
  // virtualization (prepend-with-virtualization is its own task).
  useEffect(() => {
    hasOlderRef.current = effectiveHasOlder;
    loadingOlderRef.current = effectiveLoadingOlder;
    messagesRef.current = messages;
  });

  useEffect(() => {
    const el = threadRef.current;
    if (!el) return;
    if (!onLoadOlder) return;

    const checkAndTrigger = (): void => {
      // Bail if a load is already in flight or the server says there's
      // nothing older. We re-read the closure values via fresh refs each
      // call so a stale handler doesn't keep firing.
      if (!hasOlderRef.current) return;
      if (loadingOlderRef.current) return;
      if (pendingPrependRef.current) return; // capture not yet consumed
      if (el.scrollTop > 100) return;
      pendingPrependRef.current = {
        scrollHeight: el.scrollHeight,
        scrollTop: el.scrollTop,
        prevFirstId: messagesRef.current[0]?.id ?? null,
      };
      onLoadOlder();
    };

    el.addEventListener('scroll', checkAndTrigger, { passive: true });
    // Fire once on mount in case the thread is already short enough that
    // its top is within the trigger zone — without this the user has to
    // scroll-bump the wheel to get the first older batch.
    checkAndTrigger();
    return () => el.removeEventListener('scroll', checkAndTrigger);
  }, [onLoadOlder]);

  // Restore scroll after a prepend lands: when the captured `prevFirstId`
  // is no longer at the top (i.e., older messages were prepended ahead
  // of it), shift `scrollTop` by the growth in `scrollHeight` so the
  // user's visible cursor stays exactly where it was. If `messages`
  // changed for a non-prepend reason (an SSE message appended at the
  // tail), prevFirstId still matches and we early-return, leaving the
  // anchor in place for the eventual prepend.
  //
  // The trailing `pendingPrependRef.current = null` write is intentional:
  // standard infinite-scroll-up "consume the anchor on success" pattern.
  // react-hooks/immutability over-fires on this read-then-clear shape
  // (likely because we deep-read .current.scrollTop / .scrollHeight /
  // .prevFirstId before the clear), so it's disabled at the assignment.
  useLayoutEffect(() => {
    const el = threadRef.current;
    if (!el) return;
    if (!pendingPrependRef.current) return;
    if (messages[0]?.id === pendingPrependRef.current.prevFirstId) return;
    const delta = el.scrollHeight - pendingPrependRef.current.scrollHeight;
    if (delta > 0) {
      el.scrollTop = pendingPrependRef.current.scrollTop + delta;
    }
    // eslint-disable-next-line react-hooks/immutability -- consume-on-success anchor pattern; see comment above.
    pendingPrependRef.current = null;
  }, [messages]);

  // Scroll container for the thread. The team desk grid gives each
  // column a bounded height; the conversation's own overflow-y keeps
  // page-scroll off and puts the Claude-style scrollbar exactly where
  // the user expects — inside the center column.
  //
  // `paddingBottom` reserves airspace for the fixed composer plus a
  // comfort gap so the last bubble never grazes the composer's fade.
  // Default (DEFAULT_BOTTOM_RESERVATION = 180) is sized for the typical
  // (collapsed) composer: 20 bottom inset + ~120 card + 40 fade. The
  // caller bumps `bottomReservation` when the A2 bottom rail is
  // rendered so the last messages stay readable above the rail's
  // translucent backdrop. When the user expands the textarea toward
  // its 200px MAX_HEIGHT the topmost messages slide a bit further
  // behind the composer fade, but the user is focused on the textarea
  // at that point — that tradeoff is preserved.
  const wrap: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    flex: 1,
    minHeight: 0,
    overflowY: 'auto',
    paddingBottom: bottomReservation,
    // Disable Chrome's automatic scroll anchoring. Without this the
    // browser re-anchors to an element above the new content when the
    // list grows, which *subtracts* from `scrollTop` and masks the
    // auto-scroll pin. Documented failure mode for streaming chat lists.
    overflowAnchor: 'none',
  };

  const threadWrap: CSSProperties = {
    position: 'relative',
    width: '100%',
    maxWidth: THREAD_MAX_WIDTH,
    margin: '0 auto',
  };

  const thread: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
  };

  const jumpPill: CSSProperties = {
    position: 'fixed',
    bottom: 160,
    left: '50%',
    transform: 'translateX(-50%)',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '6px 12px',
    borderRadius: 999,
    background: 'var(--sf-bg-secondary)',
    border: '1px solid var(--sf-border)',
    fontSize: 12,
    fontFamily: 'inherit',
    color: 'var(--sf-fg-1)',
    cursor: 'pointer',
    boxShadow: '0 4px 12px rgba(0, 0, 0, 0.08)',
    zIndex: 19,
  };

  const renderNode = (node: ConversationNode) => {
    if (node.kind === 'user') {
      return <UserMessage key={node.id} text={node.text} />;
    }
    if (node.kind === 'lead') {
      return renderLeadNode(node);
    }
    if (node.kind === 'activity') {
      return renderActivityNode(node);
    }
    return null;
  };

  const renderLeadNode = (node: LeadNode) => {
    const memberId = node.fromMemberId ?? coordinatorId ?? null;
    const member = memberId ? memberLookup.get(memberId) : null;
    const agentType = member?.agentType ?? 'coordinator';
    const displayName = member?.displayName ?? 'Team Lead';
    // While the lead is mid-stream and the LLM has started writing
    // tool_use JSON (but the tool_call row hasn't landed yet), surface
    // a compact "preparing dispatch" hint so the user knows something
    // downstream is coming. Claude Code does this inline during the
    // input_json_delta phase (engine/services/api/claude.ts:2111).
    const preparingCount =
      node.streaming && toolInputPartials ? toolInputPartials.size : 0;
    return (
      <LeadMessage
        key={node.id}
        messageId={node.id}
        agentType={agentType}
        displayName={displayName}
        createdAt={node.createdAt}
        text={node.text}
        phase={node.phase}
        streaming={node.streaming}
      >
        {node.delegation.length > 0 ? (
          <DelegationCard
            tasks={node.delegation}
            memberLookup={memberLookup}
            activeMemberId={activeMemberId}
            onSelectMember={onSelectMember}
            activeSubagentIds={activeSubagentIds}
          />
        ) : null}
        {preparingCount > 0 ? (
          <PreparingDispatchIndicator count={preparingCount} />
        ) : null}
      </LeadMessage>
    );
  };

  const renderActivityNode = (node: ActivityNode) => {
    // Natural attribution: "Nova used Grep" vs "Team Lead used Grep".
    // `agentName` is stamped on spawned events by `wrapOnEventWithSpawnMeta`
    // — when present, the row was emitted inside a specialist's run, so we
    // attribute it to that specialist. Otherwise it's a coordinator call
    // — looked up by id, else "Team Lead" as a neutral, always-correct
    // label.
    let actor: string | null = null;
    if (node.agentName) {
      actor = node.agentName;
    } else {
      const coord = coordinatorId ? memberLookup.get(coordinatorId) : null;
      actor = coord?.displayName ?? 'Team Lead';
    }
    return (
      <div key={node.id}>
        <ToolActivity
          toolName={node.toolName}
          variant={node.variant}
          elapsed={node.elapsed}
          complete={node.complete}
          errorText={node.errorText}
          actor={actor}
        />
        {node.progress.length > 0 ? (
          <div
            style={{
              padding: '0 0 6px 56px',
              display: 'flex',
              flexDirection: 'column',
              gap: 2,
            }}
          >
            {node.progress.map((line, i) => (
              <div
                key={i}
                style={{
                  fontFamily: 'var(--sf-font-mono)',
                  fontSize: 12,
                  color: 'var(--sf-fg-3)',
                  lineHeight: 1.4,
                }}
              >
                · {line}
              </div>
            ))}
          </div>
        ) : null}
      </div>
    );
  };

  // Flatten groups into VirtualConversation-compatible items. Session
  // dividers are first-class items in the windowed list so they scroll
  // with their group instead of being yanked out into a sticky header.
  // Each item carries a stable `id` so the virtualizer's measurement
  // cache survives streaming deltas and `loadOlder` prepends.
  type FlatItem =
    | { kind: 'divider'; id: string; group: SessionGroup }
    | { kind: 'node'; id: string; node: ConversationNode };
  const flatItems: FlatItem[] = useMemo(() => {
    if (!useVirtualized) return [];
    const out: FlatItem[] = [];
    for (const group of visibleGroups) {
      out.push({
        kind: 'divider',
        id: `divider:${group.key}`,
        group,
      });
      for (const node of group.nodes) {
        out.push({ kind: 'node', id: node.id, node });
      }
    }
    return out;
  }, [useVirtualized, visibleGroups]);

  const renderFlatItem = (item: FlatItem): ReactNode => {
    if (item.kind === 'divider') {
      return (
        <SessionDivider
          runId={item.group.runId}
          run={item.group.run}
        />
      );
    }
    return renderNode(item.node);
  };

  return (
    <section
      style={wrap}
      aria-label="Conversation"
      ref={threadRef}
      data-testid="conversation-thread"
      data-virtualized={useVirtualized ? 'true' : 'false'}
    >
      <div style={threadWrap}>
        {visibleGroups.length > 0 && (effectiveHasOlder || effectiveLoadingOlder) ? (
          <OlderHistoryIndicator loading={effectiveLoadingOlder} />
        ) : null}
        {visibleGroups.length === 0 ? (
          <div style={thread} ref={contentRef} data-testid="conversation-thread-content">
            <EmptyConversation
              onPrefillComposer={onPrefillComposer}
              onFocusComposer={onFocusComposer}
            />
          </div>
        ) : useVirtualized ? (
          <>
            <VirtualConversation
              ref={contentRef}
              nodes={flatItems}
              renderNode={renderFlatItem}
              scrollElementRef={threadRef}
              imperativeRef={virtualHandleRef}
              estimateSize={120}
              overscan={6}
            />
            {showTyping ? (
              <TypingIndicator
                label={
                  toolInputPartials && toolInputPartials.size > 0
                    ? 'dispatching'
                    : 'working'
                }
              />
            ) : null}
          </>
        ) : (
          <div style={thread} ref={contentRef} data-testid="conversation-thread-content">
            {visibleGroups.map((group) => (
              <div
                key={group.key}
                data-testid="session-group"
                data-run-id={group.runId ?? ''}
              >
                <SessionDivider runId={group.runId} run={group.run} />
                {group.nodes.map(renderNode)}
              </div>
            ))}
            {showTyping ? (
              <TypingIndicator
                label={
                  toolInputPartials && toolInputPartials.size > 0
                    ? 'dispatching'
                    : 'working'
                }
              />
            ) : null}
          </div>
        )}
        {paused && visibleGroups.length > 0 ? (
          <button
            type="button"
            style={jumpPill}
            onClick={jumpToBottom}
            data-testid="jump-to-latest"
            aria-label="Jump to latest"
          >
            Jump to latest ↓
          </button>
        ) : null}
      </div>
    </section>
  );
}

/**
 * Top-of-thread sentinel for the older-history infinite scroll. Shows a
 * subtle "Load earlier..." idle state while there's still server-side
 * history to fetch, and switches to a tiny spinner during the fetch.
 * Click target is generous so the user can manually nudge a load if
 * the auto-scroll trigger missed (very short threads, etc).
 */
function OlderHistoryIndicator({ loading }: { loading: boolean }) {
  const wrap: CSSProperties = {
    display: 'flex',
    justifyContent: 'center',
    padding: '12px 16px 8px',
    color: 'var(--sf-fg-3)',
    fontSize: 12,
    fontFamily: 'var(--sf-font-mono)',
    letterSpacing: '0.04em',
  };
  const spinner: CSSProperties = {
    width: 10,
    height: 10,
    borderRadius: '50%',
    border: '1.5px solid rgba(0, 0, 0, 0.1)',
    borderTopColor: 'var(--sf-accent)',
    animation: 'sf-spin 0.9s linear infinite',
    marginRight: 8,
  };
  return (
    <div style={wrap} role="status" aria-live="polite">
      {loading ? <span style={spinner} aria-hidden="true" /> : null}
      <span>{loading ? 'Loading earlier messages…' : 'Scroll up for earlier history'}</span>
      <style jsx>{`
        @keyframes sf-spin {
          to {
            transform: rotate(360deg);
          }
        }
      `}</style>
    </div>
  );
}

/**
 * Tiny loading strip rendered under a streaming LeadNode when the LLM
 * has started one or more `tool_use` content blocks but the tool_call
 * rows haven't landed yet. Takes the count of in-flight partials
 * (`toolInputPartials` map size) and shows a spinner + text — no
 * partial JSON rendering per the product decision.
 */
function PreparingDispatchIndicator({ count }: { count: number }) {
  const wrap: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    marginTop: 8,
    padding: '6px 10px',
    borderRadius: 6,
    background: 'rgba(0, 0, 0, 0.03)',
    fontFamily: 'var(--sf-font-mono)',
    fontSize: 11,
    color: 'var(--sf-fg-3)',
  };
  const spinner: CSSProperties = {
    width: 10,
    height: 10,
    borderRadius: '50%',
    border: '1.5px solid rgba(0, 0, 0, 0.1)',
    borderTopColor: 'var(--sf-accent)',
    animation: 'sf-spin 0.9s linear infinite',
  };
  return (
    <div style={wrap} aria-label="Preparing dispatch" role="status">
      <span style={spinner} aria-hidden="true" />
      <span>
        Preparing {count === 1 ? 'dispatch' : `${count} dispatches`}…
      </span>
      <style jsx>{`
        @keyframes sf-spin {
          to {
            transform: rotate(360deg);
          }
        }
      `}</style>
    </div>
  );
}

