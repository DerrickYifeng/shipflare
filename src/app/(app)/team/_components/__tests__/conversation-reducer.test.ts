import { describe, it, expect } from 'vitest';
import { stitchLeadMessages } from '../conversation-reducer';
import type { TeamActivityMessage } from '@/hooks/use-team-events';

function msg(
  partial: Partial<TeamActivityMessage> & { type: string; createdAt?: string },
): TeamActivityMessage {
  return {
    id: partial.id ?? `m-${Math.random().toString(36).slice(2, 8)}`,
    runId: partial.runId ?? 'run-1',
    conversationId: partial.conversationId ?? 'conv-1',
    teamId: partial.teamId ?? 'team-1',
    from: partial.from ?? null,
    to: partial.to ?? null,
    type: partial.type,
    content: partial.content ?? null,
    metadata: partial.metadata ?? null,
    createdAt: partial.createdAt ?? '2026-05-02T13:45:00.000Z',
  };
}

describe('stitchLeadMessages — subagent routing (regression)', () => {
  it('treats coordinator agent_text as a top-level LeadNode', () => {
    const messages = [
      msg({
        type: 'agent_text',
        from: 'coord-member',
        content: 'Plan looks good — dispatching now.',
        // No spawnMeta-derived metadata — coordinator is the top of the stack.
        metadata: null,
      }),
    ];
    const nodes = stitchLeadMessages(messages);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].kind).toBe('lead');
  });

  it('routes subagent agent_text into delegation when parentToolUseId is set (canonical path)', () => {
    const messages = [
      msg({
        type: 'agent_text',
        from: 'discovery-member',
        content: 'I found 6 candidates.',
        metadata: { parentToolUseId: 'toolu_abc', agentName: 'discovery-agent' },
      }),
    ];
    const nodes = stitchLeadMessages(messages);
    // Subagent text should NOT bubble up as a LeadNode.
    expect(nodes.filter((n) => n.kind === 'lead')).toHaveLength(0);
  });

  it('routes subagent agent_text away from top-level even when parentToolUseId is missing — backstop on agentName', () => {
    // This is the production bug: parentToolUseId was missing on a
    // discovery-agent agent_text row, so the row bubbled up and the UI
    // rendered it as the coordinator (Chief of Staff). The agentName
    // backstop catches this case.
    const messages = [
      msg({
        type: 'agent_text',
        from: 'discovery-member',
        content: '```json\n{ "keep": true, "score": 0.82 }\n```',
        metadata: { agentName: 'discovery-agent' }, // parentToolUseId missing
      }),
    ];
    const nodes = stitchLeadMessages(messages);
    expect(nodes.filter((n) => n.kind === 'lead')).toHaveLength(0);
  });

  it('does NOT route messages whose agentName is exactly "coordinator" — that is the lead', () => {
    const messages = [
      msg({
        type: 'agent_text',
        from: 'coord-member',
        content: 'Synthesizing the results.',
        metadata: { agentName: 'coordinator' },
      }),
    ];
    const nodes = stitchLeadMessages(messages);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].kind).toBe('lead');
  });
});
