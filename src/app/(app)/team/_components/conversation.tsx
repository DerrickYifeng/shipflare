'use client';

import {
  useLayoutEffect,
  useMemo,
  useRef,
  type CSSProperties,
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
  groupByRun,
  stitchLeadMessages,
  type ActivityNode,
  type ConversationNode,
  type LeadNode,
  type SessionGroup,
  type TaskLookup,
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
  taskLookup?: TaskLookup;
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
}

const THREAD_MAX_WIDTH = 740;

const SUGGESTION_CHIPS: readonly string[] = [
  "Plan next week's posts for my product",
  'Find 3 Reddit threads I should reply to today',
  'Draft a launch-day announcement for X',
];

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
  taskLookup,
  runLookup,
  activeMemberId,
  onSelectMember,
  isLive = false,
  onPrefillComposer,
  onFocusComposer,
  focusPendingMessageId = null,
}: ConversationProps) {
  const memberLookup = useMemo(() => {
    const map = new Map<string, DelegationCardMember>();
    for (const m of members) {
      map.set(m.id, { id: m.id, agentType: m.agentType, displayName: m.displayName });
    }
    return map;
  }, [members]);

  const nodes: ConversationNode[] = useMemo(
    () => stitchLeadMessages(messages, taskLookup, partials),
    [messages, taskLookup, partials],
  );

  const groups: SessionGroup[] = useMemo(
    () => groupByRun(nodes, runLookup),
    [nodes, runLookup],
  );

  // The caller (TeamDesk) pre-filters `messages` to the selected
  // conversation. This component just renders every group it receives
  // — no visibility decisions here. Empty thread → welcome screen.
  const visibleGroups: SessionGroup[] = groups;

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
  }, [firstRunId, jumpToBottom, unstick, focusPendingMessageId]);

  // Scroll container for the thread. The team desk grid gives each
  // column a bounded height; the conversation's own overflow-y keeps
  // page-scroll off and puts the Claude-style scrollbar exactly where
  // the user expects — inside the center column.
  //
  // `paddingBottom` reserves airspace for the fixed composer plus a
  // comfort gap so the last bubble never grazes the composer's fade.
  // Sized for the worst case (textarea expanded to its MAX_HEIGHT of
  // 200px): 20 bottom inset + ~286 card + 40 fade ≈ 346. 360 gives a
  // ~15px comfort gap even at max composer expansion.
  const wrap: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    flex: 1,
    minHeight: 0,
    overflowY: 'auto',
    paddingBottom: 360,
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
    // parentTaskId present → subagent context; prefer `agentName` meta
    // (shipped today) and only fall back to the raw member displayName
    // once Phase F provisions a team_members row per spawn. Main-thread
    // calls attribute to the coordinator — looked up by id, else
    // "Team Lead" as a neutral, always-correct label.
    let actor: string | null = null;
    if (node.parentTaskId) {
      const member = node.agentName ? null : null;
      actor = node.agentName ?? member ?? 'Specialist';
    } else {
      const coord = coordinatorId ? memberLookup.get(coordinatorId) : null;
      actor = coord?.displayName ?? 'Team Lead';
    }
    return (
      <ToolActivity
        key={node.id}
        toolName={node.toolName}
        variant={node.variant}
        elapsed={node.elapsed}
        complete={node.complete}
        errorText={node.errorText}
        actor={actor}
      />
    );
  };

  return (
    <section
      style={wrap}
      aria-label="Conversation"
      ref={threadRef}
      data-testid="conversation-thread"
    >
      <div style={threadWrap}>
        <div style={thread} ref={contentRef} data-testid="conversation-thread-content">
          {visibleGroups.length === 0 ? (
            <EmptyConversation
              onPrefillComposer={onPrefillComposer}
              onFocusComposer={onFocusComposer}
            />
          ) : (
            <>
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
            </>
          )}
        </div>
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

interface EmptyStateProps {
  onPrefillComposer?: (text: string) => void;
  onFocusComposer?: () => void;
}

function EmptyConversation({
  onPrefillComposer,
  onFocusComposer,
}: EmptyStateProps) {
  const wrap: CSSProperties = {
    padding: '32px 20px',
    background: 'var(--sf-bg-primary)',
    borderRadius: 12,
    textAlign: 'center',
    color: 'rgba(0, 0, 0, 0.48)',
    fontSize: 13,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 14,
  };
  return (
    <div style={wrap}>
      <span>Brief your Team Lead below to kick off the first run.</span>
      <SuggestionChips
        onPrefillComposer={onPrefillComposer}
        onFocusComposer={onFocusComposer}
      />
    </div>
  );
}

interface SuggestionChipsProps {
  onPrefillComposer?: (text: string) => void;
  onFocusComposer?: () => void;
}

function SuggestionChips({
  onPrefillComposer,
  onFocusComposer,
}: SuggestionChipsProps) {
  if (!onPrefillComposer && !onFocusComposer) return null;
  const row: CSSProperties = {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 8,
    justifyContent: 'center',
  };
  const chip: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    padding: '8px 12px',
    borderRadius: 8,
    background: 'var(--sf-bg-tertiary)',
    color: 'var(--sf-fg-1)',
    fontSize: 12,
    fontFamily: 'inherit',
    lineHeight: 1.3,
    border: 'none',
    cursor: 'pointer',
    textAlign: 'left',
    transition: 'background 160ms var(--sf-ease-swift)',
  };
  const handleClick = (text: string) => {
    if (onPrefillComposer) {
      onPrefillComposer(text);
      return;
    }
    onFocusComposer?.();
  };
  return (
    <div style={row} data-testid="suggestion-chips">
      {SUGGESTION_CHIPS.map((text) => (
        <button
          key={text}
          type="button"
          style={chip}
          onClick={() => handleClick(text)}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLButtonElement).style.background =
              'var(--sf-bg-primary)';
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLButtonElement).style.background =
              'var(--sf-bg-tertiary)';
          }}
          data-testid="suggestion-chip"
        >
          {text}
        </button>
      ))}
    </div>
  );
}
