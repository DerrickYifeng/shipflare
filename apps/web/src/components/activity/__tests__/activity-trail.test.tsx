// Tests for the ActivityTrail / ActivityRow / ActivityToggle components
// (Task 13 of plan 2026-05-15-agent-activity-feed.md).
//
// Lives under src/**/__tests__ so vitest picks it up via the "dom" project
// in apps/web/vitest.config.ts (happy-dom environment + @vitejs/plugin-react
// for JSX).
//
// We avoid @testing-library/jest-dom (not installed) and use plain
// vitest assertions + DOM queries.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import { ActivityTrail, buildGroups } from '../activity-trail';
import type { ActivityEvent } from '@shipflare/shared';

const baseEvent = (over: Partial<ActivityEvent>): ActivityEvent => ({
  id: 'e-1',
  createdAt: Date.now(),
  conversationId: 'c-1',
  parentTurnId: 't-1',
  runId: null,
  sourceAgent: 'cmo',
  parentEventId: null,
  kind: 'turn_start',
  payload: { kind: 'turn_start' },
  ...over,
});

function textContent(container: HTMLElement): string {
  return container.textContent ?? '';
}

describe('ActivityTrail', () => {
  it('renders the ticker when running and collapsed by default', () => {
    const events: ActivityEvent[] = [
      baseEvent({
        id: '1',
        kind: 'subagent_dispatch',
        payload: { kind: 'subagent_dispatch', subAgent: 'head-of-growth' },
      }),
    ];
    const { container } = render(<ActivityTrail events={events} />);
    expect(textContent(container)).toContain('Asking Head of Growth');
    expect(textContent(container)).toContain('Activity (1)');
    // Collapsed by default — no row elements rendered.
    expect(container.querySelectorAll('[data-activity-row]')).toHaveLength(0);
  });

  it('expands to show rows when toggle is clicked', () => {
    const events: ActivityEvent[] = [
      baseEvent({
        id: '1',
        createdAt: 1000,
        kind: 'subagent_dispatch',
        payload: { kind: 'subagent_dispatch', subAgent: 'head-of-growth' },
      }),
      baseEvent({
        id: '2',
        createdAt: 2000,
        kind: 'subagent_finish',
        payload: {
          kind: 'subagent_finish',
          subAgent: 'head-of-growth',
          status: 'ok',
          durationMs: 100,
        },
      }),
    ];
    const { container, getByText } = render(<ActivityTrail events={events} />);
    fireEvent.click(getByText(/Activity \(2\)/i));
    const row = container.querySelector('[data-activity-row]');
    expect(row).not.toBeNull();
    expect(row?.textContent).toContain('Head of Growth finished');
  });

  it('opens by default when defaultOpen is set', () => {
    const events: ActivityEvent[] = [
      baseEvent({
        id: '1',
        kind: 'subagent_dispatch',
        payload: { kind: 'subagent_dispatch', subAgent: 'head-of-growth' },
      }),
    ];
    const { container } = render(<ActivityTrail events={events} defaultOpen />);
    const rows = container.querySelectorAll('[data-activity-row]');
    expect(rows.length).toBe(1);
    // The single row's label (start, since no finish) = "Asking Head of Growth".
    expect(rows[0]?.textContent).toContain('Asking Head of Growth');
  });

  it('renders data-activity-row + data-event-id on each row', () => {
    const events: ActivityEvent[] = [
      baseEvent({
        id: 'evt-abc',
        kind: 'subagent_dispatch',
        payload: { kind: 'subagent_dispatch', subAgent: 'head-of-growth' },
      }),
    ];
    const { container } = render(<ActivityTrail events={events} defaultOpen />);
    const row = container.querySelector(
      '[data-activity-row][data-event-id="evt-abc"]',
    );
    expect(row).not.toBeNull();
  });

  describe('with fake timers', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('auto-hides ticker 1.5s after the last finish', () => {
      const events: ActivityEvent[] = [
        baseEvent({
          id: '1',
          createdAt: 1000,
          kind: 'subagent_dispatch',
          payload: {
            kind: 'subagent_dispatch',
            subAgent: 'head-of-growth',
          },
        }),
        baseEvent({
          id: '2',
          createdAt: 2000,
          kind: 'subagent_finish',
          payload: {
            kind: 'subagent_finish',
            subAgent: 'head-of-growth',
            status: 'ok',
            durationMs: 100,
          },
        }),
      ];
      const { container } = render(<ActivityTrail events={events} />);
      // No running leaf — there's no ticker text containing the ellipsis.
      expect(textContent(container)).not.toMatch(/Asking Head of Growth…/);
      act(() => {
        vi.advanceTimersByTime(1500);
      });
      expect(textContent(container)).not.toMatch(/Asking Head of Growth…/);
    });

    it('keeps ticker visible while a leaf is still running', () => {
      const events: ActivityEvent[] = [
        baseEvent({
          id: '1',
          createdAt: 1000,
          kind: 'subagent_dispatch',
          payload: {
            kind: 'subagent_dispatch',
            subAgent: 'head-of-growth',
          },
        }),
      ];
      const { container } = render(<ActivityTrail events={events} />);
      expect(textContent(container)).toMatch(/Asking Head of Growth…/);
      act(() => {
        vi.advanceTimersByTime(5000);
      });
      // Still no finish — ticker remains.
      expect(textContent(container)).toMatch(/Asking Head of Growth…/);
    });
  });

  it('respects hideTicker', () => {
    const events: ActivityEvent[] = [
      baseEvent({
        id: '1',
        kind: 'subagent_dispatch',
        payload: { kind: 'subagent_dispatch', subAgent: 'head-of-growth' },
      }),
    ];
    const { container } = render(
      <ActivityTrail events={events} hideTicker />,
    );
    // The ticker line is gone, but the toggle still renders.
    expect(textContent(container)).not.toMatch(/Asking Head of Growth…/);
    expect(textContent(container)).toContain('Activity (1)');
  });

  it('sorts events defensively when start/finish arrive same-ms in reverse', () => {
    // Same createdAt — finish must NOT be treated as the "running" leaf even
    // if it appears first in the input array.
    const events: ActivityEvent[] = [
      baseEvent({
        id: 'finish',
        createdAt: 1000,
        kind: 'subagent_finish',
        payload: {
          kind: 'subagent_finish',
          subAgent: 'head-of-growth',
          status: 'ok',
          durationMs: 0,
        },
      }),
      baseEvent({
        id: 'start',
        createdAt: 1000,
        kind: 'subagent_dispatch',
        payload: { kind: 'subagent_dispatch', subAgent: 'head-of-growth' },
      }),
    ];
    const { container } = render(<ActivityTrail events={events} defaultOpen />);
    const rows = container.querySelectorAll('[data-activity-row]');
    expect(rows.length).toBe(1);
    expect(rows[0]?.textContent).toContain('Head of Growth finished');
    // And no running ticker is rendered (no ellipsis).
    expect(textContent(container)).not.toMatch(/Asking Head of Growth…/);
  });

  describe('buildGroups', () => {
    it('pairs a top-level start with its matching finish', () => {
      const events: ActivityEvent[] = [
        baseEvent({
          id: 's1',
          createdAt: 1000,
          kind: 'subagent_dispatch',
          payload: { kind: 'subagent_dispatch', subAgent: 'head-of-growth' },
        }),
        baseEvent({
          id: 'f1',
          createdAt: 2000,
          kind: 'subagent_finish',
          payload: {
            kind: 'subagent_finish',
            subAgent: 'head-of-growth',
            status: 'ok',
            durationMs: 100,
          },
        }),
      ];
      const groups = buildGroups(events);
      expect(groups).toHaveLength(1);
      expect(groups[0]?.start.id).toBe('s1');
      expect(groups[0]?.finish?.id).toBe('f1');
      expect(groups[0]?.status).toBe('done');
    });

    it('attaches children to their parent group', () => {
      const events: ActivityEvent[] = [
        baseEvent({
          id: 'p',
          createdAt: 1000,
          kind: 'subagent_dispatch',
          payload: { kind: 'subagent_dispatch', subAgent: 'head-of-growth' },
        }),
        baseEvent({
          id: 'c1',
          createdAt: 1100,
          parentEventId: 'p',
          sourceAgent: 'head-of-growth',
          kind: 'subagent_tool_call_start',
          payload: {
            kind: 'subagent_tool_call_start',
            subAgent: 'head-of-growth',
            tool: 'x_search',
          },
        }),
        baseEvent({
          id: 'c1f',
          createdAt: 1200,
          parentEventId: 'p',
          sourceAgent: 'head-of-growth',
          kind: 'subagent_tool_call_finish',
          payload: {
            kind: 'subagent_tool_call_finish',
            subAgent: 'head-of-growth',
            tool: 'x_search',
            status: 'ok',
            durationMs: 50,
          },
        }),
      ];
      const groups = buildGroups(events);
      expect(groups).toHaveLength(1);
      expect(groups[0]?.children).toHaveLength(1);
      expect(groups[0]?.children[0]?.start.id).toBe('c1');
      expect(groups[0]?.children[0]?.finish?.id).toBe('c1f');
      expect(groups[0]?.children[0]?.status).toBe('done');
    });

    it('does not cross-pair two starts that share parent + sourceAgent + kind', () => {
      // Two sibling tool calls under the same parent. Each should pair with
      // its own finish, in order.
      const events: ActivityEvent[] = [
        baseEvent({
          id: 'p',
          createdAt: 1000,
          kind: 'subagent_dispatch',
          payload: { kind: 'subagent_dispatch', subAgent: 'head-of-growth' },
        }),
        baseEvent({
          id: 'a',
          createdAt: 1100,
          parentEventId: 'p',
          sourceAgent: 'head-of-growth',
          kind: 'subagent_tool_call_start',
          payload: {
            kind: 'subagent_tool_call_start',
            subAgent: 'head-of-growth',
            tool: 'x_search',
          },
        }),
        baseEvent({
          id: 'a_f',
          createdAt: 1150,
          parentEventId: 'p',
          sourceAgent: 'head-of-growth',
          kind: 'subagent_tool_call_finish',
          payload: {
            kind: 'subagent_tool_call_finish',
            subAgent: 'head-of-growth',
            tool: 'x_search',
            status: 'ok',
            durationMs: 50,
          },
        }),
        baseEvent({
          id: 'b',
          createdAt: 1200,
          parentEventId: 'p',
          sourceAgent: 'head-of-growth',
          kind: 'subagent_tool_call_start',
          payload: {
            kind: 'subagent_tool_call_start',
            subAgent: 'head-of-growth',
            tool: 'x_search',
          },
        }),
        baseEvent({
          id: 'b_f',
          createdAt: 1250,
          parentEventId: 'p',
          sourceAgent: 'head-of-growth',
          kind: 'subagent_tool_call_finish',
          payload: {
            kind: 'subagent_tool_call_finish',
            subAgent: 'head-of-growth',
            tool: 'x_search',
            status: 'ok',
            durationMs: 50,
          },
        }),
      ];
      const groups = buildGroups(events);
      expect(groups).toHaveLength(1);
      expect(groups[0]?.children).toHaveLength(2);
      expect(groups[0]?.children[0]?.start.id).toBe('a');
      expect(groups[0]?.children[0]?.finish?.id).toBe('a_f');
      expect(groups[0]?.children[1]?.start.id).toBe('b');
      expect(groups[0]?.children[1]?.finish?.id).toBe('b_f');
    });

    it('runs in <50ms for 1000 events', () => {
      // 500 top-level subagent_dispatch start/finish pairs (1000 events).
      const events: ActivityEvent[] = [];
      for (let i = 0; i < 500; i++) {
        const start = 1000 + i * 10;
        events.push(
          baseEvent({
            id: `s${i}`,
            createdAt: start,
            kind: 'subagent_dispatch',
            payload: {
              kind: 'subagent_dispatch',
              subAgent: 'head-of-growth',
            },
          }),
        );
        events.push(
          baseEvent({
            id: `f${i}`,
            createdAt: start + 5,
            kind: 'subagent_finish',
            payload: {
              kind: 'subagent_finish',
              subAgent: 'head-of-growth',
              status: 'ok',
              durationMs: 5,
            },
          }),
        );
      }
      // Warm-up to mitigate JIT noise on the first call.
      buildGroups(events);

      const t0 = performance.now();
      const groups = buildGroups(events);
      const elapsed = performance.now() - t0;

      expect(groups).toHaveLength(500);
      expect(elapsed).toBeLessThan(50);
    });
  });

  it('aggregates subagent_text_delta onto its parent row as sub line', () => {
    const events: ActivityEvent[] = [
      baseEvent({
        id: 'p1',
        createdAt: 1000,
        kind: 'subagent_dispatch',
        payload: { kind: 'subagent_dispatch', subAgent: 'strategic-planner' },
      }),
      baseEvent({
        id: 'd1',
        createdAt: 1100,
        parentEventId: 'p1',
        sourceAgent: 'strategic-planner',
        kind: 'subagent_text_delta',
        payload: {
          kind: 'subagent_text_delta',
          subAgent: 'strategic-planner',
          text: 'streaming planner output here',
        },
      }),
    ];
    const { container } = render(<ActivityTrail events={events} defaultOpen />);
    // No standalone row for the text delta.
    const rows = container.querySelectorAll('[data-activity-row]');
    expect(rows.length).toBe(1);
    expect(rows[0]?.getAttribute('data-event-id')).toBe('p1');
    // Sub line reflects the latest delta text.
    expect(rows[0]?.textContent).toContain('streaming planner output here');
  });
});
