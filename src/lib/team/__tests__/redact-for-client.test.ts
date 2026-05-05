import { describe, expect, it } from 'vitest';
import {
  publicToolLabel,
  publicAgentLabel,
  publicSkillLabel,
  redactMetadataForClient,
  redactContentBlocksForClient,
  redactMessageRowForClient,
  resolveOverrideContent,
} from '../redact-for-client';

describe('redact-for-client module exports', () => {
  it('exports six functions', () => {
    expect(typeof publicToolLabel).toBe('function');
    expect(typeof publicAgentLabel).toBe('function');
    expect(typeof publicSkillLabel).toBe('function');
    expect(typeof redactMetadataForClient).toBe('function');
    expect(typeof redactContentBlocksForClient).toBe('function');
    expect(typeof redactMessageRowForClient).toBe('function');
  });
});

describe('publicToolLabel', () => {
  it.each([
    // Platform actions → 'posting' or specific label
    ['x_post', 'posting'],
    ['reddit_post', 'posting'],
    ['reddit_submit_post', 'posting'],
    ['reddit_verify', 'verifying'],
    ['reddit_search', 'searching'],
    ['x_get_mentions', 'monitoring'],
    ['x_get_tweet', 'reading-history'],

    // AI vendor binding → MUST hide xai
    ['xai_find_customers', 'searching'],
    ['find_threads_via_xai', 'searching'],
    ['find_threads', 'searching'],

    // Internal queries
    ['query_strategic_path', 'reading-plan'],
    ['query_plan_items', 'reading-plan'],
    ['query_product_context', 'reading-context'],
    ['query_recent_milestones', 'reading-context'],
    ['query_team_status', 'reading-team'],
    ['query_metrics', 'reading-metrics'],
    ['query_stalled_items', 'reading-metrics'],
    ['query_recent_x_posts', 'reading-history'],

    // Plan editing
    ['add_plan_item', 'planning'],
    ['update_plan_item', 'planning'],
    ['write_strategic_path', 'planning'],
    ['generate_strategic_path', 'planning'],

    // Content
    ['draft_post', 'drafting'],
    ['draft_reply', 'drafting'],
    ['validate_draft', 'reviewing'],

    // Pipeline
    ['process_posts_batch', 'batching'],
    ['process_replies_batch', 'batching'],
    ['persist_queue_threads', 'queueing'],

    // Memory
    ['read_memory', 'reading-context'],

    // Meta tools (Anthropic-standard naming, low IP value, but normalized)
    ['Task', 'delegating'],
    ['SendMessage', 'messaging'],
    ['Sleep', 'sleeping'],
    ['TaskStop', 'cancelling'],
    ['StructuredOutput', 'tool'],
    ['SyntheticOutput', 'tool'],

    // Skills
    ['skill', 'skill'],
    ['skill_drafting-post', 'skill'],
    ['skill_judging-thread-quality', 'skill'],
    ['skill_validating-draft', 'skill'],
    ['skill_generating-strategy', 'skill'],
  ])('maps %s -> %s', (raw, label) => {
    expect(publicToolLabel(raw)).toBe(label);
  });

  it('returns "tool" for unknown names (deny-by-default)', () => {
    expect(publicToolLabel('some_future_internal_tool')).toBe('tool');
  });

  it('returns "tool" for null/undefined', () => {
    expect(publicToolLabel(null)).toBe('tool');
    expect(publicToolLabel(undefined)).toBe('tool');
    expect(publicToolLabel('')).toBe('tool');
  });
});

describe('publicAgentLabel', () => {
  it.each([
    ['coordinator', 'Team Lead'],
    ['social-media-manager', 'Content Specialist'],
  ])('maps %s -> %s', (raw, label) => {
    expect(publicAgentLabel(raw)).toBe(label);
  });

  it('returns "agent" for unknown / null', () => {
    expect(publicAgentLabel(null)).toBe('agent');
    expect(publicAgentLabel(undefined)).toBe('agent');
    expect(publicAgentLabel('')).toBe('agent');
    expect(publicAgentLabel('some-future-internal-agent')).toBe('agent');
  });
});

describe('publicSkillLabel', () => {
  it('always returns "skill" — gerund names never leak', () => {
    expect(publicSkillLabel('drafting-post')).toBe('skill');
    expect(publicSkillLabel('judging-thread-quality')).toBe('skill');
    expect(publicSkillLabel('validating-draft')).toBe('skill');
    expect(publicSkillLabel(null)).toBe('skill');
  });
});

describe('redactMetadataForClient', () => {
  it('returns null when input is null/undefined', () => {
    expect(redactMetadataForClient(null)).toBeNull();
    expect(redactMetadataForClient(undefined)).toBeNull();
  });

  it('redacts a tool_call metadata: maps tool_name, drops tool_input.prompt', () => {
    const input = {
      tool_use_id: 'tu_1',
      tool_name: 'Task',
      tool_input: {
        subagent_type: 'social-media-manager',
        description: 'fill reply slot abc-123',
        prompt: 'Mode: discover-and-fill-slot\nplanItemId: abc-123\n...',
      },
      parent_tool_use_id: null,
      agent_name: 'coordinator',
    };

    const out = redactMetadataForClient(input);

    expect(out).toEqual({
      tool_use_id: 'tu_1',
      tool_name: 'delegating',
      tool_input: {
        agent: 'Content Specialist',
        description: 'fill reply slot abc-123',
      },
      parent_tool_use_id: null,
      agent_name: 'Team Lead',
    });
  });

  it('renames subagent_type to agent on the wire (Anthropic-fingerprint suppression)', () => {
    const out = redactMetadataForClient({
      tool_name: 'Task',
      tool_input: { subagent_type: 'social-media-manager', description: 'fill reply slot' },
    });
    // The wire key is `agent`, not `subagent_type`
    expect((out!.tool_input as Record<string, unknown>)).toEqual({
      description: 'fill reply slot',
      agent: 'Content Specialist',
    });
    // Adversarial: bare key `subagent_type` must not appear anywhere
    expect(JSON.stringify(out)).not.toContain('subagent_type');
  });

  it('redacts xai-flavored tool name + drops raw prompt', () => {
    const input = {
      tool_use_id: 'tu_2',
      tool_name: 'find_threads_via_xai',
      tool_input: {
        query: 'startup founders complaining about cold outreach',
        from_date: '2026-01-01',
      },
    };

    const out = redactMetadataForClient(input);

    expect(out).toEqual({
      tool_use_id: 'tu_2',
      tool_name: 'searching',
      tool_input: {}, // no description / agent
    });

    // The raw query string MUST NOT appear anywhere in the output
    expect(JSON.stringify(out)).not.toContain('startup founders');
    expect(JSON.stringify(out)).not.toContain('xai');
  });

  it('redacts SkillTool metadata: strips skill name + args', () => {
    const input = {
      tool_use_id: 'tu_3',
      tool_name: 'skill',
      tool_input: {
        skill: 'judging-thread-quality',
        args: '{"thread": "...", "rubric": "..."}',
      },
    };

    const out = redactMetadataForClient(input);

    expect(out).toEqual({
      tool_use_id: 'tu_3',
      tool_name: 'skill',
      tool_input: {},
    });
    expect(JSON.stringify(out)).not.toContain('judging-thread-quality');
    expect(JSON.stringify(out)).not.toContain('rubric');
  });

  it('redacts a tool_result metadata: drops tool_output, keeps duration + is_error', () => {
    const input = {
      tool_use_id: 'tu_1',
      tool_name: 'validate_draft',
      tool_output: 'REJECT: tone mismatch — cf rubric §3.2',
      is_error: false,
      duration_ms: 1200,
    };

    const out = redactMetadataForClient(input);

    expect(out).toEqual({
      tool_use_id: 'tu_1',
      tool_name: 'reviewing',
      is_error: false,
      duration_ms: 1200,
    });
    expect(out).not.toHaveProperty('tool_output');
    expect(JSON.stringify(out)).not.toContain('rubric');
  });

  it('drops publicContent (already swapped into content by caller)', () => {
    const input = {
      tool_use_id: 'tu_x',
      tool_name: 'add_plan_item',
      publicContent: 'Setting up your week-1 plan',
    };
    const out = redactMetadataForClient(input);
    expect(out).not.toHaveProperty('publicContent');
  });

  it('drops unknown metadata keys (deny-by-default)', () => {
    const input = {
      tool_use_id: 'tu_x',
      tool_name: 'add_plan_item',
      future_field_with_secret: 'XAI_API_KEY=sk-...',
      another_internal_thing: { nested: 'leak' },
    };
    const out = redactMetadataForClient(input);
    expect(out).not.toHaveProperty('future_field_with_secret');
    expect(out).not.toHaveProperty('another_internal_thing');
    expect(JSON.stringify(out)).not.toContain('XAI_API_KEY');
    expect(JSON.stringify(out)).not.toContain('leak');
  });

  it('handles camelCase keys too (toolName, toolInput, parentToolUseId, agentName)', () => {
    const input = {
      toolUseId: 'tu_4',
      toolName: 'find_threads_via_xai',
      toolInput: { query: 'secret', description: 'searching for leads' },
      parentToolUseId: 'tu_3',
      agentName: 'social-media-manager',
    };

    const out = redactMetadataForClient(input);

    expect(out).toEqual({
      toolUseId: 'tu_4',
      toolName: 'searching',
      toolInput: { description: 'searching for leads' },
      parentToolUseId: 'tu_3',
      agentName: 'Content Specialist',
    });
  });

  it('prefers snake_case over camelCase when both present', () => {
    const out = redactMetadataForClient({
      tool_name: 'x_post',
      toolName: 'find_threads_via_xai',
    });
    expect(out?.tool_name).toBe('posting');
    expect(out).not.toHaveProperty('toolName');
  });

  it('does not truncate description at exactly 200 chars', () => {
    const at200 = 'x'.repeat(200);
    const out = redactMetadataForClient({
      tool_name: 'Task',
      tool_input: { description: at200, subagent_type: 'social-media-manager' },
    });
    expect((out!.tool_input as { description: string }).description).toBe(at200);
  });

  it('preserves empty description', () => {
    const out = redactMetadataForClient({
      tool_name: 'Task',
      tool_input: { description: '', subagent_type: 'social-media-manager' },
    });
    expect((out!.tool_input as { description: string }).description).toBe('');
  });

  it('truncates description longer than 200 chars', () => {
    const longDesc = 'x'.repeat(500);
    const input = {
      tool_name: 'Task',
      tool_input: { description: longDesc, subagent_type: 'social-media-manager' },
    };
    const out = redactMetadataForClient(input);
    expect((out!.tool_input as { description: string }).description.length).toBe(200);
  });
});

describe('redactContentBlocksForClient', () => {
  it('passes through plain text blocks', () => {
    const blocks = [{ type: 'text', text: 'Hello, founder!' }];
    expect(redactContentBlocksForClient(blocks)).toEqual(blocks);
  });

  it('redacts tool_use block input + maps name', () => {
    const blocks = [
      {
        type: 'tool_use',
        id: 'tu_1',
        name: 'find_threads_via_xai',
        input: { query: 'secret query string', from_date: '2026-01-01' },
      },
    ];

    const out = redactContentBlocksForClient(blocks);

    expect(out).toEqual([
      {
        type: 'tool_use',
        id: 'tu_1',
        name: 'searching',
        input: {},
      },
    ]);
    expect(JSON.stringify(out)).not.toContain('secret query');
    expect(JSON.stringify(out)).not.toContain('xai');
  });

  it('redacts Task tool_use: keeps description + maps subagent_type → agent', () => {
    const blocks = [
      {
        type: 'tool_use',
        id: 'tu_2',
        name: 'Task',
        input: {
          subagent_type: 'social-media-manager',
          description: 'fill reply slot',
          prompt: 'Mode: discover-and-fill-slot\n...',
        },
      },
    ];

    const out = redactContentBlocksForClient(blocks);

    expect(out).toEqual([
      {
        type: 'tool_use',
        id: 'tu_2',
        name: 'delegating',
        input: { agent: 'Content Specialist', description: 'fill reply slot' },
      },
    ]);
  });

  it('renames tool_use input.subagent_type to input.agent on the wire', () => {
    const blocks = [
      {
        type: 'tool_use',
        id: 'tu_1',
        name: 'Task',
        input: { subagent_type: 'social-media-manager', description: 'fill slot' },
      },
    ];
    const out = redactContentBlocksForClient(blocks) as Array<Record<string, unknown>>;
    expect((out[0].input as Record<string, unknown>)).toEqual({
      agent: 'Content Specialist',
      description: 'fill slot',
    });
    expect(JSON.stringify(out)).not.toContain('subagent_type');
  });

  it('redacts tool_result blocks: keeps id + is_error, drops content', () => {
    const blocks = [
      {
        type: 'tool_result',
        tool_use_id: 'tu_1',
        is_error: false,
        content: 'REJECT: tone mismatch — cf rubric §3.2',
      },
    ];

    const out = redactContentBlocksForClient(blocks);

    expect(out).toEqual([
      {
        type: 'tool_result',
        tool_use_id: 'tu_1',
        is_error: false,
        content: '[redacted]',
      },
    ]);
  });

  it('returns input unchanged for non-array', () => {
    expect(redactContentBlocksForClient(null)).toBeNull();
    expect(redactContentBlocksForClient(undefined)).toBeUndefined();
    expect(redactContentBlocksForClient('plain string')).toBe('plain string');
  });

  it('returns [] for empty array input', () => {
    expect(redactContentBlocksForClient([])).toEqual([]);
  });

  it('redacts tool_use block with undefined name to "tool"', () => {
    const blocks = [
      { type: 'tool_use', id: 'tu_x', name: undefined as unknown as string, input: {} },
    ];
    expect(redactContentBlocksForClient(blocks)).toEqual([
      { type: 'tool_use', id: 'tu_x', name: 'tool', input: {} },
    ]);
  });

  it('mixed blocks: redacts only the dangerous ones', () => {
    const blocks = [
      { type: 'text', text: 'I am thinking...' },
      {
        type: 'tool_use',
        id: 'tu_3',
        name: 'judging-thread-quality',
        input: { thread_id: 't1' },
      },
      { type: 'text', text: 'Done.' },
    ];

    const out = redactContentBlocksForClient(blocks) as Array<Record<string, unknown>>;

    expect(out[0]).toEqual({ type: 'text', text: 'I am thinking...' });
    expect(out[1]).toEqual({
      type: 'tool_use',
      id: 'tu_3',
      name: 'tool', // judging-thread-quality is not a registered Anthropic tool name
      input: {},
    });
    expect(out[2]).toEqual({ type: 'text', text: 'Done.' });
  });
});

describe('redactMessageRowForClient', () => {
  const baseRow = {
    id: 'm1',
    runId: 'r1',
    teamId: 't1',
    type: 'tool_call',
    content: null,
    contentBlocks: null,
    metadata: null,
    createdAt: new Date('2026-05-04T00:00:00Z'),
  };

  it('redacts metadata + leaves identifiers intact', () => {
    const row = {
      ...baseRow,
      metadata: {
        tool_use_id: 'tu_1',
        tool_name: 'find_threads_via_xai',
        tool_input: { query: 'secret' },
      },
    };
    const out = redactMessageRowForClient(row);
    expect(out.id).toBe('m1');
    expect(out.runId).toBe('r1');
    expect(out.metadata).toEqual({
      tool_use_id: 'tu_1',
      tool_name: 'searching',
      tool_input: {},
    });
  });

  it('swaps content with metadata.publicContent if present', () => {
    const row = {
      ...baseRow,
      type: 'user_prompt',
      content:
        'First-visit kickoff for Acme. Strategic path pathId=... weekStart=... ' +
        'Follow your kickoff playbook end-to-end (plan → social-media-manager): ...',
      metadata: {
        trigger: 'kickoff',
        publicContent: 'Setting up your week-1 plan and content for Acme.',
      },
    };
    const out = redactMessageRowForClient(row);
    expect(out.content).toBe('Setting up your week-1 plan and content for Acme.');
    expect(out.metadata).toEqual({ trigger: 'kickoff' }); // publicContent dropped
    expect(out.content).not.toContain('social-media-manager');
    expect(out.content).not.toContain('playbook');
  });

  it('passes content through when publicContent absent', () => {
    const row = {
      ...baseRow,
      type: 'user_prompt',
      content: 'Hey team, what should I post today?',
      metadata: { trigger: 'conversation_message' },
    };
    const out = redactMessageRowForClient(row);
    expect(out.content).toBe('Hey team, what should I post today?');
  });

  it('handles row with metadata = undefined', () => {
    const row = {
      id: 'm1',
      runId: null,
      teamId: 't1',
      type: 'assistant_text',
      content: 'plain text',
      contentBlocks: null,
      metadata: undefined as unknown as Record<string, unknown> | null,
      createdAt: new Date('2026-05-04T00:00:00Z'),
    };
    const out = redactMessageRowForClient(row);
    expect(out.metadata).toBeNull();
    expect(out.content).toBe('plain text');
  });

  it('redacts contentBlocks if present', () => {
    const row = {
      ...baseRow,
      type: 'assistant_text',
      contentBlocks: [
        { type: 'text', text: 'Thinking...' },
        {
          type: 'tool_use',
          id: 'tu_1',
          name: 'find_threads_via_xai',
          input: { query: 'secret' },
        },
      ],
    };
    const out = redactMessageRowForClient(row);
    expect(out.contentBlocks).toEqual([
      { type: 'text', text: 'Thinking...' },
      { type: 'tool_use', id: 'tu_1', name: 'searching', input: {} },
    ]);
  });

  it('substitutes friendly default for internal trigger without publicContent (kickoff)', () => {
    const row = {
      id: 'm1',
      runId: 'r1',
      teamId: 't1',
      type: 'user_prompt',
      content:
        'First-visit kickoff for Acme. Strategic path... Follow your kickoff playbook ' +
        'end-to-end (plan → social-media-manager): (1) Generate week-1 plan items...',
      contentBlocks: null,
      metadata: { trigger: 'kickoff' }, // ← no publicContent (historical row)
      createdAt: new Date('2026-05-04T00:00:00Z'),
    };
    const out = redactMessageRowForClient(row);
    expect(out.content).toBe('Building your first-week plan and drafting your first reply candidates.');
    expect(out.content).not.toContain('social-media-manager');
    expect(out.content).not.toContain('playbook');
    expect(out.content).not.toContain('Strategic path');
  });

  it.each([
    ['phase_transition', 'Updating your strategy for the new product phase.'],
    ['daily', 'Running your daily automation.'],
    ['weekly', 'Running your weekly automation.'],
    ['onboarding', 'Working through onboarding.'],
    ['task_retry', 'Retrying a previously failed task.'],
  ])('substitutes default for trigger=%s without publicContent', (trigger, expected) => {
    const row = {
      id: 'm1',
      runId: 'r1',
      teamId: 't1',
      type: 'user_prompt',
      content: 'Internal goal with secret architecture references...',
      contentBlocks: null,
      metadata: { trigger },
      createdAt: new Date(),
    };
    const out = redactMessageRowForClient(row);
    expect(out.content).toBe(expected);
  });

  it('falls back to generic default for unknown internal trigger', () => {
    const row = {
      id: 'm1',
      runId: 'r1',
      teamId: 't1',
      type: 'user_prompt',
      content: 'A leaky internal goal',
      contentBlocks: null,
      metadata: { trigger: 'some_future_internal_trigger' },
      createdAt: new Date(),
    };
    const out = redactMessageRowForClient(row);
    expect(out.content).toBe('Working on automated work.');
  });

  it('preserves raw content for user-facing trigger (conversation_message)', () => {
    const row = {
      id: 'm1',
      runId: 'r1',
      teamId: 't1',
      type: 'user_prompt',
      content: 'Hey team, what should I post today?',
      contentBlocks: null,
      metadata: { trigger: 'conversation_message' },
      createdAt: new Date(),
    };
    const out = redactMessageRowForClient(row);
    expect(out.content).toBe('Hey team, what should I post today?'); // verbatim
  });

  it('passes content through for assistant turn (no trigger field)', () => {
    const row = {
      id: 'm1',
      runId: 'r1',
      teamId: 't1',
      type: 'assistant_text',
      content: "I'll start by reviewing your context.",
      contentBlocks: null,
      metadata: { tool_use_id: 'tu_1', is_error: false }, // no trigger
      createdAt: new Date(),
    };
    const out = redactMessageRowForClient(row);
    expect(out.content).toBe("I'll start by reviewing your context.");
  });

  it('publicContent overrides trigger default when both present', () => {
    const row = {
      id: 'm1',
      runId: 'r1',
      teamId: 't1',
      type: 'user_prompt',
      content: 'raw internal goal',
      contentBlocks: null,
      metadata: { trigger: 'kickoff', publicContent: 'Custom summary for this kickoff.' },
      createdAt: new Date(),
    };
    const out = redactMessageRowForClient(row);
    expect(out.content).toBe('Custom summary for this kickoff.'); // publicContent wins
  });

  it('swaps contentBlocks to match swapped content (publicContent path)', () => {
    const row = {
      id: 'm1',
      runId: 'r1',
      teamId: 't1',
      type: 'user_prompt',
      content: 'raw kickoff goal with social-media-manager',
      contentBlocks: [
        { type: 'text', text: 'raw kickoff goal with social-media-manager' },
      ],
      metadata: {
        trigger: 'kickoff',
        publicContent: 'Setting up your week-1 plan.',
      },
      createdAt: new Date(),
    };
    const out = redactMessageRowForClient(row);
    expect(out.content).toBe('Setting up your week-1 plan.');
    expect(out.contentBlocks).toEqual([
      { type: 'text', text: 'Setting up your week-1 plan.' },
    ]);
    expect(JSON.stringify(out)).not.toContain('social-media-manager');
  });

  it('swaps contentBlocks to match trigger fallback (no publicContent)', () => {
    const row = {
      id: 'm1',
      runId: 'r1',
      teamId: 't1',
      type: 'user_prompt',
      content: 'raw kickoff goal with social-media-manager',
      contentBlocks: [
        { type: 'text', text: 'raw kickoff goal with social-media-manager' },
      ],
      metadata: { trigger: 'kickoff' }, // no publicContent (historical row)
      createdAt: new Date(),
    };
    const out = redactMessageRowForClient(row);
    expect(out.content).toBe('Building your first-week plan and drafting your first reply candidates.');
    expect(out.contentBlocks).toEqual([
      { type: 'text', text: 'Building your first-week plan and drafting your first reply candidates.' },
    ]);
    expect(JSON.stringify(out)).not.toContain('social-media-manager');
  });

  it('preserves contentBlocks for assistant turns (no override)', () => {
    const row = {
      id: 'm1',
      runId: 'r1',
      teamId: 't1',
      type: 'assistant_text',
      content: "I'll help with that.",
      contentBlocks: [{ type: 'text', text: "I'll help with that." }],
      metadata: { tool_use_id: 'tu_1' },
      createdAt: new Date(),
    };
    const out = redactMessageRowForClient(row);
    expect(out.contentBlocks).toEqual([
      { type: 'text', text: "I'll help with that." },
    ]);
  });
});

describe('resolveOverrideContent', () => {
  it('returns publicContent when set', () => {
    expect(resolveOverrideContent({ trigger: 'kickoff', publicContent: 'X' })).toBe(
      'X',
    );
  });

  it('returns trigger default when no publicContent', () => {
    expect(resolveOverrideContent({ trigger: 'kickoff' })).toBe(
      'Building your first-week plan and drafting your first reply candidates.',
    );
  });

  it('returns null for user-facing trigger', () => {
    expect(resolveOverrideContent({ trigger: 'conversation_message' })).toBeNull();
  });

  it('returns generic fallback for unknown internal trigger', () => {
    expect(resolveOverrideContent({ trigger: 'mystery' })).toBe(
      'Working on automated work.',
    );
  });

  it('returns null for null metadata', () => {
    expect(resolveOverrideContent(null)).toBeNull();
  });

  it('returns null for undefined metadata', () => {
    expect(resolveOverrideContent(undefined)).toBeNull();
  });

  it('returns null for assistant turn (no trigger)', () => {
    expect(resolveOverrideContent({ tool_use_id: 'tu_1' })).toBeNull();
  });

  it('publicContent wins over trigger fallback', () => {
    expect(
      resolveOverrideContent({
        trigger: 'kickoff',
        publicContent: 'Custom override.',
      }),
    ).toBe('Custom override.');
  });
});
