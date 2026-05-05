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
        from: 'social-member',
        content: 'I found 6 candidates.',
        metadata: { parentToolUseId: 'toolu_abc', agentName: 'social-media-manager' },
      }),
    ];
    const nodes = stitchLeadMessages(messages);
    // Subagent text should NOT bubble up as a LeadNode.
    expect(nodes.filter((n) => n.kind === 'lead')).toHaveLength(0);
  });

  it('routes subagent agent_text away from top-level even when parentToolUseId is missing — backstop on agentName', () => {
    // This is the production bug: parentToolUseId was missing on a
    // subagent agent_text row, so the row bubbled up and the UI rendered
    // it as the coordinator (Chief of Staff). The agentName backstop
    // catches this case.
    const messages = [
      msg({
        type: 'agent_text',
        from: 'social-member',
        content: '```json\n{ "keep": true, "score": 0.82 }\n```',
        metadata: { agentName: 'social-media-manager' }, // parentToolUseId missing
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

  it('routes subagent agent_text away from top-level when metadata uses snake_case (production shape)', () => {
    // Regression: agent-run.ts persists `parent_tool_use_id` and
    // `agent_name` (snake_case) on team_messages.metadata — the JSONB
    // column shape DB rows actually carry. The earlier hasSubagentName
    // helper read only camelCase `agentName`, so the agentName backstop
    // never fired for any real persisted row, and a fork-skill's verdict
    // (e.g. judging-thread-quality returning a JSON object) showed up
    // briefly under the lead's avatar during streaming.
    const messages = [
      msg({
        type: 'agent_text',
        from: 'coord-member', // skill events fall back to lead's memberId because skills aren't team_members
        content: '{ "keep": true, "score": 0.88 }',
        metadata: { agent_name: 'judging-thread-quality' }, // snake_case, no parentToolUseId
      }),
    ];
    const nodes = stitchLeadMessages(messages);
    expect(nodes.filter((n) => n.kind === 'lead')).toHaveLength(0);
  });
});

describe('stitchLeadMessages — nested progress under in-tool ProgressItems', () => {
  it('nests sub-events under in-tool ProgressItems by tool_use_id', () => {
    // Scenario mirrors production: coord lead text → Task tool_call
    // (DelegationTask) → social-media-manager runs find_threads_via_xai
    // → that tool spawns 3 runForkSkill children whose messages carry
    // parent_tool_use_id = find_threads_via_xai's tool_use_id.
    //
    // Before the fix, populateDelegationProgress only grafted buckets
    // onto DelegationTasks (Task spawns), never onto in-tool items —
    // so the find_threads_via_xai card sat at "RUNNING" for minutes
    // with no live progress. After the fix, the nested bucket lands on
    // the tool ProgressItem's `subItems`.
    const TASK_USE_ID = 'toolu_task_dispatch';
    const FIND_USE_ID = 'toolu_find_threads_xai';
    const messages: TeamActivityMessage[] = [
      // 1. Coordinator opens with lead text
      msg({
        id: 'm-lead',
        type: 'agent_text',
        from: 'coord-member',
        content: 'Dispatching social-media-manager.',
        createdAt: '2026-05-03T10:00:00.000Z',
      }),
      // 2. Coordinator calls Task → opens DelegationTask
      msg({
        id: 'm-task-call',
        type: 'tool_call',
        from: 'coord-member',
        metadata: {
          // Wire shape: redactor maps raw `'Task'` → `'delegating'` and
          // renames `subagent_type` → `agent` (see redact-for-client.ts).
          // The reducer sees this redacted shape from the API.
          toolName: 'delegating',
          toolUseId: TASK_USE_ID,
          input: { agent: 'Content Specialist', description: 'Find threads' },
        },
        createdAt: '2026-05-03T10:00:01.000Z',
      }),
      // 3. Inside the subagent: tool_call for find_threads_via_xai.
      //    parentToolUseId points to the Task spawn so it lands in the
      //    DelegationTask's progressItems bucket.
      msg({
        id: 'm-find-call',
        type: 'tool_call',
        from: 'social-member',
        metadata: {
          toolName: 'find_threads_via_xai',
          toolUseId: FIND_USE_ID,
          parentToolUseId: TASK_USE_ID,
          agentName: 'social-media-manager',
        },
        createdAt: '2026-05-03T10:00:02.000Z',
      }),
      // 4-6. Three sub-events (e.g. runForkSkill calls) whose
      //      parentToolUseId is find_threads_via_xai's id.
      msg({
        id: 'm-sub-1',
        type: 'tool_call',
        from: 'social-member',
        metadata: {
          toolName: 'skill_judging-thread-quality',
          toolUseId: 'toolu_sub_1',
          parentToolUseId: FIND_USE_ID,
          agentName: 'judging-thread-quality',
        },
        createdAt: '2026-05-03T10:00:03.000Z',
      }),
      msg({
        id: 'm-sub-2',
        type: 'tool_call',
        from: 'social-member',
        metadata: {
          toolName: 'skill_judging-thread-quality',
          toolUseId: 'toolu_sub_2',
          parentToolUseId: FIND_USE_ID,
          agentName: 'judging-thread-quality',
        },
        createdAt: '2026-05-03T10:00:04.000Z',
      }),
      msg({
        id: 'm-sub-3',
        type: 'tool_call',
        from: 'social-member',
        metadata: {
          toolName: 'skill_judging-thread-quality',
          toolUseId: 'toolu_sub_3',
          parentToolUseId: FIND_USE_ID,
          agentName: 'judging-thread-quality',
        },
        createdAt: '2026-05-03T10:00:05.000Z',
      }),
    ];

    const nodes = stitchLeadMessages(messages);
    const lead = nodes.find((n) => n.kind === 'lead');
    expect(lead).toBeDefined();
    if (!lead || lead.kind !== 'lead') throw new Error('lead missing');
    expect(lead.delegation).toHaveLength(1);
    const task = lead.delegation[0];
    expect(task.toolUseId).toBe(TASK_USE_ID);
    expect(task.progressItems.length).toBeGreaterThan(0);

    // The find_threads_via_xai tool ProgressItem
    const findItem = task.progressItems.find(
      (p): p is Extract<typeof p, { kind: 'tool' }> =>
        p.kind === 'tool' && p.toolName === 'find_threads_via_xai',
    );
    expect(findItem).toBeDefined();
    expect(findItem!.toolUseId).toBe(FIND_USE_ID);
    // The 3 sub-events should be grafted onto subItems.
    expect(findItem!.subItems).toBeDefined();
    expect(findItem!.subItems).toHaveLength(3);
    // Each sub-event is a tool item for skill_judging-thread-quality.
    for (const sub of findItem!.subItems!) {
      expect(sub.kind).toBe('tool');
      if (sub.kind === 'tool') {
        expect(sub.toolName).toBe('skill_judging-thread-quality');
      }
    }
  });
});

describe('stitchLeadMessages — fork progress fallback', () => {
  it('attaches fork-skill progress (mismatched toolName) to most-recent in-flight tool_call', () => {
    // Scenario: find_threads_via_xai is in flight; runForkSkill emits two
    // progress events with toolName='judging-thread-quality' (the skill's
    // own name, not the calling tool's name). The primary toolName-match
    // path won't find a tool_call card for 'judging-thread-quality', so
    // the fallback should attach the lines to find_threads_via_xai's card
    // and prefix each with the skill name so 5 parallel forks stay
    // legible.
    const FIND_USE_ID = 'toolu_find_threads_xai';
    const messages: TeamActivityMessage[] = [
      msg({
        id: 'm-find-call',
        type: 'tool_call',
        from: 'coord-member',
        metadata: {
          toolName: 'find_threads_via_xai',
          toolUseId: FIND_USE_ID,
        },
        createdAt: '2026-05-04T10:00:00.000Z',
      }),
      msg({
        id: 'm-prog-1',
        type: 'tool_progress',
        from: 'coord-member',
        // toolName here is the SKILL name, no tool_call by that name exists
        metadata: {
          toolName: 'judging-thread-quality',
          skillName: 'judging-thread-quality',
        },
        content: 'fork started',
        createdAt: '2026-05-04T10:00:01.000Z',
      }),
      msg({
        id: 'm-prog-2',
        type: 'tool_progress',
        from: 'coord-member',
        metadata: {
          toolName: 'judging-thread-quality',
          skillName: 'judging-thread-quality',
        },
        content: 'fork done in 8200ms',
        createdAt: '2026-05-04T10:00:09.000Z',
      }),
    ];
    const nodes = stitchLeadMessages(messages);
    // The find_threads_via_xai tool_call lands as an `activity` node with
    // variant 'tool'. Both progress lines should attach to its progress[]
    // array, prefixed with [judging-thread-quality].
    const findNode = nodes.find(
      (n) =>
        n.kind === 'activity' &&
        n.variant === 'tool' &&
        n.toolName === 'find_threads_via_xai',
    );
    expect(findNode).toBeDefined();
    if (findNode?.kind !== 'activity') throw new Error('expected activity node');
    expect(findNode.progress).toEqual([
      '[judging-thread-quality] fork started',
      '[judging-thread-quality] fork done in 8200ms',
    ]);
  });

  it('does NOT prefix when the progress event toolName matches the parent (regular emitProgress path)', () => {
    // Regression: regular tool emitProgress (e.g. xai_find_customers
    // emitting "tokens=1234" on its own card) should NOT get a
    // [skill-name] prefix because the matched node IS the emitter.
    const USE_ID = 'toolu_xai_find';
    const messages: TeamActivityMessage[] = [
      msg({
        id: 'm-call',
        type: 'tool_call',
        from: 'coord-member',
        metadata: {
          toolName: 'xai_find_customers',
          toolUseId: USE_ID,
        },
        createdAt: '2026-05-04T10:00:00.000Z',
      }),
      msg({
        id: 'm-prog',
        type: 'tool_progress',
        from: 'coord-member',
        metadata: { toolName: 'xai_find_customers' },
        content: 'tokens in/out=48367/2501',
        createdAt: '2026-05-04T10:00:05.000Z',
      }),
    ];
    const nodes = stitchLeadMessages(messages);
    const node = nodes.find(
      (n) =>
        n.kind === 'activity' &&
        n.variant === 'tool' &&
        n.toolName === 'xai_find_customers',
    );
    if (node?.kind !== 'activity') throw new Error('expected activity node');
    // No [skill-name] prefix — primary toolName match hit, no fork involved.
    expect(node.progress).toEqual(['tokens in/out=48367/2501']);
  });
});
