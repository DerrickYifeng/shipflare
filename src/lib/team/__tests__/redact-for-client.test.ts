import { describe, expect, it } from 'vitest';
import {
  publicToolLabel,
  publicAgentLabel,
  publicSkillLabel,
  redactMetadataForClient,
  redactContentBlocksForClient,
  redactMessageRowForClient,
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
        subagent_type: 'Content Specialist',
        description: 'fill reply slot abc-123',
      },
      parent_tool_use_id: null,
      agent_name: 'Team Lead',
    });
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
      tool_input: {}, // no description / subagent_type
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
