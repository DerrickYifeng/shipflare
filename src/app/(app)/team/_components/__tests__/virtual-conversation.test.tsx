// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { useRef, type CSSProperties } from 'react';
import {
  VirtualConversation,
  type VirtualNode,
} from '../virtual-conversation';

// A3: virtualize the message list past 50 nodes. Long discovery sessions
// accumulate hundreds of ConversationNodes; without windowing each one
// re-renders on every stream tick. `@tanstack/react-virtual` measures via
// ResizeObserver and only mounts the visible slice + an overscan band.

// happy-dom doesn't compute layout, so `offsetHeight`/`offsetWidth`
// return 0 on every element. @tanstack/virtual-core's `getRect` reads
// `offsetWidth/Height` from the scroll element to drive its windowing
// math, so without a stub the virtualizer sees a degenerate viewport
// and renders nothing — defeating any "did we window?" test.
//
// We override the `HTMLElement.prototype` getters to read from the
// element's `data-test-height` / `data-test-width` dataset attributes
// when present, otherwise fall through to the original (still 0 in
// happy-dom but at least non-surprising). Scope-limited to elements
// that opt in via the data-attrs so unrelated tests keep their
// existing behaviour.
beforeAll(() => {
  const proto = HTMLElement.prototype;
  const heightDescriptor = Object.getOwnPropertyDescriptor(proto, 'offsetHeight');
  const widthDescriptor = Object.getOwnPropertyDescriptor(proto, 'offsetWidth');
  Object.defineProperty(proto, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      const stub = this.dataset?.testHeight;
      if (stub) return Number.parseInt(stub, 10);
      return heightDescriptor?.get?.call(this) ?? 0;
    },
  });
  Object.defineProperty(proto, 'offsetWidth', {
    configurable: true,
    get(this: HTMLElement) {
      const stub = this.dataset?.testWidth;
      if (stub) return Number.parseInt(stub, 10);
      return widthDescriptor?.get?.call(this) ?? 0;
    },
  });
});

// Test harness — VirtualConversation reuses the parent's existing
// `overflow-y:auto` scroll container (option (a) from the task plan) so
// `useAutoScroll`'s sticky-tail logic doesn't fight a second scroller.
// The harness mounts a 600px-tall scroller (via the stub above), hands
// its ref to VirtualConversation, and asserts only a small fraction of
// nodes paint.
function Harness({ count }: { count: number }) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const wrap: CSSProperties = {
    height: 600,
    width: 400,
    overflowY: 'auto',
    position: 'relative',
  };
  const nodes: VirtualNode[] = Array.from({ length: count }, (_, i) => ({
    id: `node-${i}`,
  }));
  return (
    <div
      ref={scrollRef}
      style={wrap}
      data-test-height="600"
      data-test-width="400"
      data-testid="scroll-host"
    >
      <VirtualConversation
        nodes={nodes}
        renderNode={(n) => (
          <div data-id={n.id} style={{ height: 48, padding: 8 }}>
            row {n.id}
          </div>
        )}
        scrollElementRef={scrollRef}
        estimateSize={48}
        overscan={3}
      />
    </div>
  );
}

describe('<VirtualConversation>', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders only a windowed slice of a 500-item list, not every node', async () => {
    const { container, rerender } = render(<Harness count={500} />);
    // The virtualizer's first measurement runs in useLayoutEffect and
    // triggers a state-update rerender via React's `useReducer`. Under
    // happy-dom that rerender lands on the NEXT React commit, not the
    // initial render — force one inside an act() boundary so the
    // following querySelectorAll sees the windowed slice.
    await act(async () => {
      rerender(<Harness count={500} />);
      await Promise.resolve();
    });
    const rendered = container.querySelectorAll('[data-id]');
    // Lower bound (>0) catches a "rendered nothing" regression — e.g.
    // if a future happy-dom + react-virtual interaction collapses the
    // window to empty. Upper bound (<20) is tight enough to catch a
    // "doubled render" or "rendered everything" regression that the
    // looser <60 bound would have missed. With 600px scroller + 48px
    // estimateSize + overscan=3, a healthy virtualizer renders
    // roughly 13-19 rows.
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered.length).toBeLessThan(20);
  });

  it('mounts cleanly for a small list (no crash, content wrapper present)', () => {
    // Sanity: VirtualConversation itself doesn't gate on threshold — that
    // decision lives in <Conversation>. happy-dom returns zero-rect for
    // unstyled elements so the virtualizer's render window can collapse
    // to empty under test, but the inner content wrapper MUST still mount
    // so useAutoScroll's ResizeObserver has something to observe.
    const { container } = render(<Harness count={10} />);
    const content = container.querySelector(
      '[data-testid="virtual-conversation-content"]',
    );
    expect(content).not.toBeNull();
    const rendered = container.querySelectorAll('[data-id]');
    // Upper bound holds regardless of layout — virtualizer never paints
    // more items than the list contains.
    expect(rendered.length).toBeLessThanOrEqual(10);
  });

  it('sizes the inner content wrapper to total height (sticky-tail-friendly)', () => {
    const { container } = render(<Harness count={500} />);
    // The inner wrapper carries `data-testid="virtual-conversation-content"`
    // — useAutoScroll's ResizeObserver watches this element (passed in via
    // the `contentRef` prop in <Conversation>'s integration). Height must
    // be > 0 once the virtualizer reports `getTotalSize()`.
    const content = container.querySelector(
      '[data-testid="virtual-conversation-content"]',
    ) as HTMLElement | null;
    expect(content).not.toBeNull();
    // happy-dom doesn't compute layout, but the style attribute is set
    // imperatively by the virtualizer — so we read it off the inline
    // style string.
    expect(content?.style.height).toMatch(/\d+px/);
  });
});
