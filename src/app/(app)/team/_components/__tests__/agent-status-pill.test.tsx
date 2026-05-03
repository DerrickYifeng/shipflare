// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';

import {
  AgentStatusPill,
  type AgentStatus,
} from '../agent-status-pill';

const STATUSES: AgentStatus[] = [
  'sleeping',
  'queued',
  'running',
  'resuming',
  'completed',
  'failed',
  'killed',
];

describe('<AgentStatusPill>', () => {
  afterEach(() => {
    cleanup();
  });

  for (const status of STATUSES) {
    it(`renders the ${status} variant`, () => {
      const { container } = render(<AgentStatusPill status={status} />);
      const pill = container.querySelector(
        '[data-testid="agent-status-pill"]',
      );
      expect(pill).not.toBeNull();
      expect(pill?.getAttribute('data-status')).toBe(status);
      expect(pill?.getAttribute('role')).toBe('status');
      expect(pill?.getAttribute('aria-label')).toBe(`Agent ${status}`);
      expect(pill?.textContent ?? '').toContain(status);
      expect(container.firstChild).toMatchSnapshot();
    });
  }

  it('respects an optional label override', () => {
    const { container } = render(
      <AgentStatusPill status="running" label="drafting" />,
    );
    expect(container.textContent).toContain('drafting');
    expect(container.textContent).not.toContain('running');
  });

  it('marks the glyph aria-hidden so the label is the only label', () => {
    const { container } = render(<AgentStatusPill status="completed" />);
    const glyph = container.querySelector('[aria-hidden="true"]');
    expect(glyph).not.toBeNull();
    // Glyph (✓) is decorative; the visible label "completed" carries
    // semantics together with aria-label="Agent completed" on the wrapper.
    expect(glyph?.textContent).toBe('✓');
  });
});
