// @vitest-environment happy-dom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

import {
  TaskNotificationCard,
  parseTaskNotification,
} from '../task-notification-card';
import { synthesizeTaskNotification } from '@/workers/processors/lib/synthesize-notification';

// Round-trip helper: build XML through the production synthesizer so we
// stay locked to the real schema instead of duplicating its shape here.
function makeXml(
  overrides: Partial<Parameters<typeof synthesizeTaskNotification>[0]> = {},
): string {
  return synthesizeTaskNotification({
    agentId: overrides.agentId ?? 'agent-1',
    status: overrides.status ?? 'completed',
    summary: overrides.summary ?? 'Drafted 3 reply variations',
    finalText:
      overrides.finalText ?? 'The replies are ready in the drafts table.',
    usage: overrides.usage ?? {
      totalTokens: 500,
      toolUses: 3,
      durationMs: 1500,
    },
  });
}

describe('parseTaskNotification', () => {
  it('parses a fully-populated payload', () => {
    const xml = makeXml();
    const data = parseTaskNotification(xml);
    expect(data).not.toBeNull();
    expect(data!.taskId).toBe('agent-1');
    expect(data!.status).toBe('completed');
    expect(data!.summary).toBe('Drafted 3 reply variations');
    expect(data!.result).toBe('The replies are ready in the drafts table.');
    expect(data!.usage).toEqual({
      totalTokens: 500,
      toolUses: 3,
      durationMs: 1500,
    });
  });

  it('decodes XML entities back to the original characters', () => {
    const xml = makeXml({
      summary: 'Drafted "v1" & <v2> in one pass',
      finalText: "It's ready.",
    });
    const data = parseTaskNotification(xml);
    expect(data!.summary).toBe('Drafted "v1" & <v2> in one pass');
    expect(data!.result).toBe("It's ready.");
  });

  it('handles failed and killed terminal statuses', () => {
    expect(parseTaskNotification(makeXml({ status: 'failed' }))!.status).toBe(
      'failed',
    );
    expect(parseTaskNotification(makeXml({ status: 'killed' }))!.status).toBe(
      'killed',
    );
  });

  it('returns null when required tags are missing', () => {
    expect(parseTaskNotification('<task-notification></task-notification>')).toBeNull();
    expect(
      parseTaskNotification('<task-notification><task-id></task-id></task-notification>'),
    ).toBeNull();
  });

  it('returns null when status is not a terminal value', () => {
    const broken = '<task-notification><task-id>a</task-id><status>running</status></task-notification>';
    expect(parseTaskNotification(broken)).toBeNull();
  });
});

describe('<TaskNotificationCard>', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders teammate name, summary, status pill, and usage chip', () => {
    render(
      <TaskNotificationCard xml={makeXml()} teammateName="reply-author" />,
    );
    expect(screen.getByText('reply-author')).toBeTruthy();
    expect(screen.getByText('Drafted 3 reply variations')).toBeTruthy();
    const pill = screen.getByTestId('agent-status-pill');
    expect(pill.getAttribute('data-status')).toBe('completed');
    const usage = screen.getByTestId('task-notification-usage');
    expect(usage.textContent).toContain('500 tokens');
    expect(usage.textContent).toContain('3 tool calls');
    expect(usage.textContent).toContain('1.5s');
  });

  it('falls back to the task id when no teammate name is supplied', () => {
    render(<TaskNotificationCard xml={makeXml({ agentId: 'agent-7' })} />);
    expect(screen.getByText('agent-7')).toBeTruthy();
  });

  it('renders failed-status card with the matching pill tone', () => {
    render(
      <TaskNotificationCard
        xml={makeXml({ status: 'failed', summary: 'Plan rejected by judge' })}
        teammateName="planner"
      />,
    );
    const card = screen.getByTestId('task-notification-card');
    expect(card.getAttribute('data-status')).toBe('failed');
    expect(screen.getByText('Plan rejected by judge')).toBeTruthy();
  });

  it('singularises tool-call label when there is exactly one', () => {
    render(
      <TaskNotificationCard
        xml={makeXml({
          usage: { totalTokens: 100, toolUses: 1, durationMs: 250 },
        })}
        teammateName="x"
      />,
    );
    const usage = screen.getByTestId('task-notification-usage');
    expect(usage.textContent).toContain('1 tool call');
    expect(usage.textContent).not.toContain('1 tool calls');
    // Sub-second durations render as raw ms so the fast-path stays legible.
    expect(usage.textContent).toContain('250ms');
  });

  it('invokes onClickAgent with the parsed task id when clicked', () => {
    const onClickAgent = vi.fn();
    render(
      <TaskNotificationCard
        xml={makeXml({ agentId: 'agent-42' })}
        teammateName="x"
        onClickAgent={onClickAgent}
      />,
    );
    fireEvent.click(screen.getByTestId('task-notification-card'));
    expect(onClickAgent).toHaveBeenCalledWith('agent-42');
  });

  it('exposes role=button + tabIndex=0 only when interactive', () => {
    const { rerender } = render(
      <TaskNotificationCard xml={makeXml()} teammateName="x" />,
    );
    let card = screen.getByTestId('task-notification-card');
    expect(card.getAttribute('role')).toBe('article');
    expect(card.getAttribute('tabindex')).toBeNull();

    rerender(
      <TaskNotificationCard
        xml={makeXml()}
        teammateName="x"
        onClickAgent={() => {}}
      />,
    );
    card = screen.getByTestId('task-notification-card');
    expect(card.getAttribute('role')).toBe('button');
    expect(card.getAttribute('tabindex')).toBe('0');
  });

  it('triggers onClickAgent on Enter and Space when interactive', () => {
    const onClickAgent = vi.fn();
    render(
      <TaskNotificationCard
        xml={makeXml({ agentId: 'kbd-1' })}
        teammateName="x"
        onClickAgent={onClickAgent}
      />,
    );
    const card = screen.getByTestId('task-notification-card');
    fireEvent.keyDown(card, { key: 'Enter' });
    fireEvent.keyDown(card, { key: ' ' });
    expect(onClickAgent).toHaveBeenCalledTimes(2);
    expect(onClickAgent).toHaveBeenNthCalledWith(1, 'kbd-1');
    expect(onClickAgent).toHaveBeenNthCalledWith(2, 'kbd-1');
  });

  it('returns null for malformed XML so it never throws on bad input', () => {
    const { container } = render(
      <TaskNotificationCard xml="<not-a-task-notification />" />,
    );
    expect(container.firstChild).toBeNull();
  });
});
