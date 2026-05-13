import { describe, it, expect } from 'vitest';
import { groupByRun, stitchLeadMessages } from '../conversation-reducer';
import type {
  AgentRunStatus,
  AgentRunStatusMap,
  ConversationNode,
  UserNode,
  LeadNode,
} from '../conversation-reducer';
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
    // it as the coordinator (CMO). The agentName backstop
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

describe('stitchLeadMessages — streaming partial subagent filter (2026-05-13)', () => {
  it('renders a coordinator partial as a top-level streaming LeadNode', () => {
    const partials = new Map([
      [
        'blk-coord',
        {
          id: 'blk-coord',
          runId: 'run-1',
          teamId: 'team-1',
          from: 'coord-member',
          to: null,
          content: 'Drafting plan…',
          createdAt: '2026-05-13T00:00:00.000Z',
          lastActivityAt: Date.now(),
          parentToolUseId: null,
          agentName: null,
        },
      ],
    ]);
    const nodes = stitchLeadMessages([], new Map(), partials);
    const leads = nodes.filter((n) => n.kind === 'lead');
    expect(leads).toHaveLength(1);
    expect((leads[0] as LeadNode).text).toBe('Drafting plan…');
  });

  it('filters subagent partials with parentToolUseId from the top-level thread', () => {
    // Production bug 2026-05-13: a teammate's mid-stream agent_text was
    // rendering under the lead's persona because the streaming SSE
    // envelope omitted spawnMeta. The worker now stamps it on the wire
    // and the reducer routes subagent partials out of the top-level
    // append — they surface in the DelegationCard / TaskPanel instead.
    const partials = new Map([
      [
        'blk-sub',
        {
          id: 'blk-sub',
          runId: 'run-1',
          teamId: 'team-1',
          from: 'social-member',
          to: null,
          content: "I'm drafting for X in the foundation phase…",
          createdAt: '2026-05-13T00:00:00.000Z',
          lastActivityAt: Date.now(),
          parentToolUseId: 'toolu_abc',
          agentName: 'social-media-manager',
        },
      ],
    ]);
    const nodes = stitchLeadMessages([], new Map(), partials);
    expect(nodes.filter((n) => n.kind === 'lead')).toHaveLength(0);
  });

  it('filters subagent partials on agentName alone — defensive backstop', () => {
    // Mirrors the durable agent_text path's defensive backstop: if
    // parentToolUseId fails to land for any reason, agentName alone is
    // enough to route the partial away from the top-level thread.
    const partials = new Map([
      [
        'blk-sub',
        {
          id: 'blk-sub',
          runId: 'run-1',
          teamId: 'team-1',
          from: 'social-member',
          to: null,
          content: 'thinking…',
          createdAt: '2026-05-13T00:00:00.000Z',
          lastActivityAt: Date.now(),
          parentToolUseId: null,
          agentName: 'social-media-manager',
        },
      ],
    ]);
    const nodes = stitchLeadMessages([], new Map(), partials);
    expect(nodes.filter((n) => n.kind === 'lead')).toHaveLength(0);
  });
});

describe('stitchLeadMessages — stripping hallucinated <task-notification> XML', () => {
  it('strips a fabricated task-notification block from lead agent_text (2026-05-12 bug)', () => {
    // Production bug: CMO occasionally hallucinates a
    // stylized <task-notification> block in its own SYNTHESIS turn —
    // a paraphrase of the user-role notification injected by
    // synthAndDeliverNotification. coordinator/AGENT.md §4 forbids it,
    // but we keep the UI strip as a defense-in-depth backstop.
    const hallucinated = [
      'May 12 X post marked drafted. Waiting on the remaining 3 agents.',
      '',
      '<task-notification> <task-id>c17f190c-…</task-id> <agent-type>social-media-manager</agent-type> <description>draft x post batch</description> <result>{"status":"completed","summary":"Drafted 1 X post"}</result> </task-notification>',
      '',
      'Reddit research complete. Top 3 subreddits: SaaS, indiehackers, entrepreneur.',
    ].join('\n');
    const messages = [
      msg({
        type: 'agent_text',
        from: 'coord-member',
        content: hallucinated,
        metadata: null,
      }),
    ];
    const nodes = stitchLeadMessages(messages);
    expect(nodes).toHaveLength(1);
    const lead = nodes[0] as LeadNode;
    expect(lead.kind).toBe('lead');
    expect(lead.text).not.toContain('<task-notification');
    expect(lead.text).not.toContain('</task-notification>');
    expect(lead.text).toContain('May 12 X post marked drafted');
    expect(lead.text).toContain('Reddit research complete');
  });

  it('leaves agent_text untouched when it contains no task-notification block', () => {
    const messages = [
      msg({
        type: 'agent_text',
        from: 'coord-member',
        content: 'Plan looks good — dispatching now.',
        metadata: null,
      }),
    ];
    const nodes = stitchLeadMessages(messages);
    const lead = nodes[0] as LeadNode;
    expect(lead.text).toBe('Plan looks good — dispatching now.');
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
          input: { agent: 'Social Media Manager', description: 'Find threads' },
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

describe('stitchLeadMessages — async Task dispatch (run_in_background)', () => {
  const TASK_USE_ID = 'toolu_async_001';
  const AGENT_ID = 'agt-async-1';

  function asyncDispatchScenario(): readonly TeamActivityMessage[] {
    return [
      msg({
        id: 'm-coord-text',
        type: 'agent_text',
        from: 'coord-member',
        content: 'Dispatching async sub-agents in parallel.',
        createdAt: '2026-05-08T17:30:00.000Z',
      }),
      msg({
        id: 'm-task-call',
        type: 'tool_call',
        from: 'coord-member',
        metadata: {
          toolName: 'delegating',
          toolUseId: TASK_USE_ID,
          input: { agent: 'Social Media Manager', description: 'fill x reply slot' },
        },
        createdAt: '2026-05-08T17:30:01.000Z',
      }),
      msg({
        id: 'm-task-result',
        type: 'tool_result',
        from: 'coord-member',
        // The Task tool's async-launched receipt — `result` is null because
        // the spawned agent_runs row is QUEUED, not finished.
        content: JSON.stringify({
          result: null,
          cost: 0,
          duration: 0,
          turns: 0,
          agentId: AGENT_ID,
          status: 'async_launched',
        }),
        metadata: { toolUseId: TASK_USE_ID },
        createdAt: '2026-05-08T17:30:03.000Z',
      }),
    ];
  }

  function makeStatusMap(entry: Partial<AgentRunStatus> & { agentId: string; status: AgentRunStatus['status'] }): AgentRunStatusMap {
    const full: AgentRunStatus = {
      parentToolUseId: TASK_USE_ID,
      spawnedAt: '2026-05-08T17:30:01.500Z',
      lastActiveAt: '2026-05-08T17:30:01.500Z',
      outputSummary: null,
      ...entry,
    };
    return new Map([[entry.agentId, full]]);
  }

  it('default (no agent_runs entry yet) renders as QUEUED — the truthful state, not the legacy RUNNING lie', () => {
    const nodes = stitchLeadMessages(asyncDispatchScenario());
    const lead = nodes.find((n): n is LeadNode => n.kind === 'lead');
    expect(lead).toBeDefined();
    expect(lead!.delegation).toHaveLength(1);
    const task = lead!.delegation[0]!;
    // Pre-refactor default was 'working' — the original sin of the bug.
    // Now the truthful default is 'queued' because no agent_runs row has
    // landed yet (or the agent_runs INSERT lost a race with the SSE
    // rebroadcast).
    expect(task.status).toBe('queued');
    // The async dispatch receipt is still parsed, so agentId is captured
    // for the eventual task_notification join.
    expect(task.agentId).toBe(AGENT_ID);
    expect(task.elapsed).toBeNull();
  });

  it('agent_runs status=running renders as WORKING', () => {
    const statusMap = makeStatusMap({ agentId: AGENT_ID, status: 'running' });
    const nodes = stitchLeadMessages(asyncDispatchScenario(), statusMap);
    const task = nodes.find((n): n is LeadNode => n.kind === 'lead')!.delegation[0]!;
    expect(task.status).toBe('working');
    expect(task.agentId).toBe(AGENT_ID);
  });

  it('agent_runs status=completed renders as DONE; task_notification back-fills outputSummary', () => {
    const statusMap = makeStatusMap({ agentId: AGENT_ID, status: 'completed' });
    const messages = [
      ...asyncDispatchScenario(),
      msg({
        id: 'm-notif',
        type: 'task_notification',
        metadata: {
          agentId: AGENT_ID,
          status: 'completed',
          summary: '8 replies drafted',
          teammateName: 'Social Media Manager',
        },
        createdAt: '2026-05-08T17:34:12.000Z',
      }),
    ];
    const nodes = stitchLeadMessages(messages, statusMap);
    const task = nodes.find((n): n is LeadNode => n.kind === 'lead')!.delegation[0]!;
    expect(task.status).toBe('done');
    expect(task.progress).toBe(100);
    expect(task.outputSummary).toBe('8 replies drafted');
    expect(task.elapsed).not.toBeNull();
  });

  it('agent_runs status=failed renders as FAILED', () => {
    const statusMap = makeStatusMap({ agentId: AGENT_ID, status: 'failed' });
    const nodes = stitchLeadMessages(asyncDispatchScenario(), statusMap);
    const task = nodes.find((n): n is LeadNode => n.kind === 'lead')!.delegation[0]!;
    expect(task.status).toBe('failed');
  });

  it('agent_runs status=killed renders as FAILED', () => {
    const statusMap = makeStatusMap({ agentId: AGENT_ID, status: 'killed' });
    const nodes = stitchLeadMessages(asyncDispatchScenario(), statusMap);
    const task = nodes.find((n): n is LeadNode => n.kind === 'lead')!.delegation[0]!;
    expect(task.status).toBe('failed');
  });

  it('agent_runs status=sleeping renders as WORKING (teammate yielded its worker slot, not terminal)', () => {
    const statusMap = makeStatusMap({ agentId: AGENT_ID, status: 'sleeping' });
    const nodes = stitchLeadMessages(asyncDispatchScenario(), statusMap);
    const task = nodes.find((n): n is LeadNode => n.kind === 'lead')!.delegation[0]!;
    expect(task.status).toBe('working');
  });

  it('live agent_status_change events apply on top of the SSR-seeded map (latest-wins)', () => {
    // Seed: queued. Live event: running. Expected: working.
    const statusMap = makeStatusMap({ agentId: AGENT_ID, status: 'queued' });
    const messages = [
      ...asyncDispatchScenario(),
      msg({
        id: 'm-status-running',
        type: 'agent_status_change',
        metadata: {
          agentId: AGENT_ID,
          status: 'running',
          lastActiveAt: '2026-05-08T17:30:05.000Z',
          parentToolUseId: TASK_USE_ID,
        },
        createdAt: '2026-05-08T17:30:05.000Z',
      }),
      // Then completed:
      msg({
        id: 'm-status-completed',
        type: 'agent_status_change',
        metadata: {
          agentId: AGENT_ID,
          status: 'completed',
          lastActiveAt: '2026-05-08T17:34:00.000Z',
          parentToolUseId: TASK_USE_ID,
        },
        createdAt: '2026-05-08T17:34:00.000Z',
      }),
    ];
    const nodes = stitchLeadMessages(messages, statusMap);
    const task = nodes.find((n): n is LeadNode => n.kind === 'lead')!.delegation[0]!;
    expect(task.status).toBe('done');
  });

  it('live agent_status_change works even without an SSR seed (parentToolUseId carries the join key)', () => {
    // No SSR map — agent_runs row only reaches the client via the live
    // SSE channel. The reducer should still join on parentToolUseId and
    // render the truthful status.
    const messages = [
      ...asyncDispatchScenario(),
      msg({
        id: 'm-status',
        type: 'agent_status_change',
        metadata: {
          agentId: AGENT_ID,
          status: 'running',
          parentToolUseId: TASK_USE_ID,
        },
        createdAt: '2026-05-08T17:30:05.000Z',
      }),
    ];
    const nodes = stitchLeadMessages(messages);
    const task = nodes.find((n): n is LeadNode => n.kind === 'lead')!.delegation[0]!;
    expect(task.status).toBe('working');
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

describe('groupByRun — orphan DM placement (regression)', () => {
  function user(id: string, runId: string | null, at: string): UserNode {
    return { kind: 'user', id, createdAt: at, runId, text: id };
  }
  function lead(id: string, runId: string, at: string): LeadNode {
    return {
      kind: 'lead',
      id,
      createdAt: at,
      runId,
      fromMemberId: 'coord',
      text: id,
      delegation: [],
      phase: 'PLAN',
    };
  }

  it('opens a fresh orphan group when a DM follows a run group', () => {
    // Founder sends msg-1 (no run yet), lead spins up R1 and replies,
    // founder sends msg-2 mid-conversation, lead spins R2 and replies.
    // Bug pre-fix: msg-1 + msg-2 collapsed into one __no_run__ bucket
    // at the top of the thread; msg-2 visually preceded R1 even though
    // it was sent later. Fix: msg-2 starts a new orphan bucket so it
    // renders between R1 and R2 in chronological order.
    const nodes: ConversationNode[] = [
      user('msg-1', null, '2026-05-05T21:40:00.000Z'),
      lead('R1-plan', 'R1', '2026-05-05T21:42:00.000Z'),
      lead('R1-synth', 'R1', '2026-05-05T21:44:00.000Z'),
      user('msg-2', null, '2026-05-05T21:45:00.000Z'),
      lead('R2-plan', 'R2', '2026-05-05T21:46:00.000Z'),
    ];
    const groups = groupByRun(nodes);

    expect(groups.map((g) => g.key)).toEqual([
      '__no_run__',
      'R1',
      '__no_run__:1',
      'R2',
    ]);
    expect(groups[0].nodes.map((n) => n.id)).toEqual(['msg-1']);
    expect(groups[2].nodes.map((n) => n.id)).toEqual(['msg-2']);
  });

  it('coalesces consecutive orphan DMs into the same bucket', () => {
    // Two DMs sent back-to-back before any run starts should still
    // group together — the bucket only splits on a run boundary.
    const nodes: ConversationNode[] = [
      user('msg-a', null, '2026-05-05T21:40:00.000Z'),
      user('msg-b', null, '2026-05-05T21:40:30.000Z'),
      lead('R1', 'R1', '2026-05-05T21:42:00.000Z'),
    ];
    const groups = groupByRun(nodes);

    expect(groups.map((g) => g.key)).toEqual(['__no_run__', 'R1']);
    expect(groups[0].nodes.map((n) => n.id)).toEqual(['msg-a', 'msg-b']);
  });
});
