// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { Conversation, type ConversationMember } from '../conversation';
import type { TeamActivityMessage } from '@/hooks/use-team-events';

// A3: <Conversation> must swap to <VirtualConversation> when the flat
// node count exceeds VIRTUALIZATION_NODE_THRESHOLD (50). The decision
// is exposed via `data-virtualized` on the outer section so this test
// — and any downstream Playwright smoke — can assert the active path
// without coupling to the rendered DOM shape.

function msg(i: number): TeamActivityMessage {
  // Alternating user / agent text — `stitchLeadMessages` turns each
  // into one ConversationNode (user → UserNode, agent_text → LeadNode),
  // so message count is a 1:1 proxy for flat node count.
  return {
    id: `m-${i}`,
    runId: 'run-1',
    conversationId: 'conv-1',
    teamId: 'team-1',
    from: i % 2 === 0 ? null : 'coord-member',
    to: null,
    type: i % 2 === 0 ? 'user_prompt' : 'agent_text',
    content: i % 2 === 0 ? `user msg ${i}` : `lead reply ${i}`,
    metadata: null,
    createdAt: new Date(2026, 4, 12, 10, 0, i).toISOString(),
  };
}

const MEMBERS: readonly ConversationMember[] = [
  { id: 'coord-member', agentType: 'coordinator', displayName: 'Team Lead' },
];

describe('<Conversation> virtualization swap at threshold 50', () => {
  afterEach(() => {
    cleanup();
  });

  it('uses the simple render path for short conversations (<= 50 nodes)', () => {
    const messages = Array.from({ length: 30 }, (_, i) => msg(i));
    const { container } = render(
      <Conversation
        members={MEMBERS}
        coordinatorId="coord-member"
        messages={messages}
        activeMemberId={null}
        onSelectMember={() => {}}
      />,
    );
    const section = container.querySelector(
      '[data-testid="conversation-thread"]',
    );
    expect(section).not.toBeNull();
    expect(section?.getAttribute('data-virtualized')).toBe('false');
    // The non-virtualized content wrapper is the source of truth for
    // useAutoScroll's ResizeObserver — confirm it exists.
    expect(
      container.querySelector('[data-testid="conversation-thread-content"]'),
    ).not.toBeNull();
    expect(
      container.querySelector(
        '[data-testid="virtual-conversation-content"]',
      ),
    ).toBeNull();
  });

  it('swaps to virtualized rendering for long conversations (> 50 nodes)', () => {
    // 60 messages → ~60 flat nodes after stitching (user + lead alternation).
    // Past the 50-node threshold, the section should report virtualized=true
    // and the virtual content wrapper should mount.
    const messages = Array.from({ length: 60 }, (_, i) => msg(i));
    const { container } = render(
      <Conversation
        members={MEMBERS}
        coordinatorId="coord-member"
        messages={messages}
        activeMemberId={null}
        onSelectMember={() => {}}
      />,
    );
    const section = container.querySelector(
      '[data-testid="conversation-thread"]',
    );
    expect(section).not.toBeNull();
    expect(section?.getAttribute('data-virtualized')).toBe('true');
    expect(
      container.querySelector(
        '[data-testid="virtual-conversation-content"]',
      ),
    ).not.toBeNull();
    // The non-virtualized wrapper should NOT be present in this branch
    // — Conversation's render tree exclusively picks one or the other.
    expect(
      container.querySelector('[data-testid="conversation-thread-content"]'),
    ).toBeNull();
  });
});
