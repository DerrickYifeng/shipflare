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
