import { describe, it, expect } from 'vitest';
import { synthesizeTaskNotification } from '@/workers/processors/lib/synthesize-notification';

describe('synthesizeTaskNotification', () => {
  it('produces a well-formed XML envelope with all 5 tags', () => {
    const xml = synthesizeTaskNotification({
      agentId: 'agent-a1b',
      status: 'completed',
      summary: '5 drafts produced',
      finalText: 'I produced 5 drafts.',
      usage: { totalTokens: 14523, toolUses: 23, durationMs: 87200 },
    });
    expect(xml).toContain('<task-notification>');
    expect(xml).toContain('<task-id>agent-a1b</task-id>');
    expect(xml).toContain('<status>completed</status>');
    expect(xml).toContain('<summary>5 drafts produced</summary>');
    expect(xml).toContain('<r>I produced 5 drafts.</r>');
    expect(xml).toContain('<usage>');
    expect(xml).toContain('<total_tokens>14523</total_tokens>');
    expect(xml).toContain('<tool_uses>23</tool_uses>');
    expect(xml).toContain('<duration_ms>87200</duration_ms>');
    expect(xml).toContain('</usage>');
    expect(xml).toContain('</task-notification>');
  });

  it('renders status="failed" when failed', () => {
    const xml = synthesizeTaskNotification({
      agentId: 'agent-x',
      status: 'failed',
      summary: 'API call rejected',
      finalText: 'Rate limited.',
      usage: { totalTokens: 100, toolUses: 1, durationMs: 500 },
    });
    expect(xml).toContain('<status>failed</status>');
  });

  it('renders status="killed" on TaskStop / shutdown_request approved', () => {
    const xml = synthesizeTaskNotification({
      agentId: 'agent-y',
      status: 'killed',
      summary: 'Cancelled by founder',
      finalText: '',
      usage: { totalTokens: 0, toolUses: 0, durationMs: 0 },
    });
    expect(xml).toContain('<status>killed</status>');
    // Empty <r> is acceptable
    expect(xml).toContain('<r></r>');
  });

  it('escapes XML-special characters in finalText and summary', () => {
    const xml = synthesizeTaskNotification({
      agentId: 'agent-z',
      status: 'completed',
      summary: 'Drafted reply with <code> & "quotes"',
      finalText: 'Reply: <strong>Yes</strong> & here\'s the link',
      usage: { totalTokens: 1, toolUses: 1, durationMs: 1 },
    });
    // < should be escaped; raw < would break XML parsing
    expect(xml).toContain('&lt;code&gt;');
    expect(xml).toContain('&amp;');
    expect(xml).toContain('&quot;');
    expect(xml).toContain('&lt;strong&gt;');
  });
});
