'use client';

import {
  forwardRef,
  useCallback,
  useEffect,
  type CSSProperties,
  type ReactNode,
  type Ref,
  type RefObject,
} from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

/**
 * Minimum interface a windowed item needs: a stable id for React keys and
 * virtualizer measurement caching. The actual node shape lives upstream
 * (ConversationNode etc.); VirtualConversation is generic so the same
 * primitive can serve other lists later if needed.
 */
export interface VirtualNode {
  id: string;
}

/**
 * Imperative handle exposed via the `imperativeRef` prop. Lets the
 * parent jump-to-task flow (team-desk's `focusCardNow`) scroll a
 * specific node into the visible window before running its own
 * fine-grained `scrollIntoView` on the SubtaskCard. Without this,
 * jumping to an off-screen virtualized row was a silent no-op
 * (querySelector returned null for unmounted rows).
 */
export interface VirtualConversationHandle {
  /**
   * Scroll the row with the given id into the visible window, centered
   * if possible. No-op if the id isn't in `nodes`. The actual centering
   * may be slightly off when the target row's measurement is still an
   * estimate (not yet measured) — but the row WILL mount, which is the
   * fix for the silent-failure case.
   */
  scrollToId(id: string): void;
}

export interface VirtualConversationProps<N extends VirtualNode> {
  /** Items to render, in order. Use a stable id per item. */
  nodes: readonly N[];
  /** Per-node renderer. Must not own its own keys — the wrapper supplies them. */
  renderNode: (node: N) => ReactNode;
  /**
   * The existing scroll container (the element with `overflow-y: auto`).
   * VirtualConversation does NOT create its own scroll surface — it would
   * fight `<Conversation>`'s `useAutoScroll` for ownership of the
   * sticky-tail behavior. Instead it reuses the caller's container via
   * the virtualizer's `getScrollElement` hook.
   */
  scrollElementRef: RefObject<HTMLElement | null>;
  /**
   * Initial size estimate (px) for unmeasured items. The virtualizer
   * replaces this with real measurements via ResizeObserver as items
   * paint. Default 80px is roughly the height of a typical LeadNode.
   */
  estimateSize?: number;
  /**
   * Number of items rendered outside the visible window on each side.
   * Higher = smoother scroll at the cost of more DOM. Default 6 matches
   * @tanstack/react-virtual's recommendation for chat-style lists.
   */
  overscan?: number;
  /**
   * Optional ref the component populates with a `VirtualConversationHandle`
   * so the parent can drive `scrollToId` imperatively. Separated from the
   * `forwardRef` slot (which is the content `HTMLDivElement` for
   * `useAutoScroll`'s ResizeObserver) so both wirings coexist cleanly.
   */
  imperativeRef?: RefObject<VirtualConversationHandle | null>;
}

/**
 * Windowed list rendering for long message threads. Engine equivalent:
 * Yoga-measured TaskListV2 — same principle (measure + virtualize) for
 * the same reason (long lists kill render performance).
 *
 * Integration contract:
 *  - `scrollElementRef` is the existing `<section>` that
 *    `useAutoScroll` already watches. We pass it to `useVirtualizer` via
 *    `getScrollElement` so both systems share the same scroll source.
 *  - The inner content wrapper is sized to `getTotalSize()`. We forward
 *    its ref so `useAutoScroll`'s ResizeObserver can fire whenever the
 *    measured total grows — which is exactly what keeps the sticky-tail
 *    pin working through streaming deltas.
 *  - Each item gets `data-virtual-index` so test/debug tools can match
 *    rendered children back to their virtualizer index without coupling
 *    to internal class names.
 *  - `imperativeRef` exposes `scrollToId` so the parent's jump-to-task
 *    flow can guarantee a row is mounted before its own scrollIntoView.
 */
function VirtualConversationInner<N extends VirtualNode>(
  {
    nodes,
    renderNode,
    scrollElementRef,
    estimateSize = 80,
    overscan = 6,
    imperativeRef,
  }: VirtualConversationProps<N>,
  ref: Ref<HTMLDivElement>,
) {
  const getScrollElement = useCallback(
    () => scrollElementRef.current,
    [scrollElementRef],
  );

  const virtualizer = useVirtualizer({
    count: nodes.length,
    getScrollElement,
    estimateSize: () => estimateSize,
    overscan,
    // Stable id per item — required for measurement cache to survive
    // prepends (loadOlder) and re-orderings.
    getItemKey: (index) => nodes[index]?.id ?? `idx-${index}`,
  });

  // Populate the imperative handle so the parent can drive scrollToId.
  // We don't use `useImperativeHandle` here because the forwardRef slot
  // is already taken by the content HTMLDivElement (needed by
  // useAutoScroll's ResizeObserver). A plain effect that writes to the
  // caller's ref keeps both wirings independent.
  useEffect(() => {
    if (!imperativeRef) return;
    imperativeRef.current = {
      scrollToId: (id: string): void => {
        const idx = nodes.findIndex((n) => n.id === id);
        if (idx < 0) return;
        virtualizer.scrollToIndex(idx, { align: 'center' });
      },
    };
    return () => {
      if (imperativeRef) imperativeRef.current = null;
    };
  }, [imperativeRef, nodes, virtualizer]);

  const totalSize = virtualizer.getTotalSize();
  const items = virtualizer.getVirtualItems();

  const containerStyle: CSSProperties = {
    height: `${totalSize}px`,
    width: '100%',
    position: 'relative',
  };

  return (
    <div
      ref={ref}
      style={containerStyle}
      data-testid="virtual-conversation-content"
    >
      {items.map((virtualRow) => {
        const node = nodes[virtualRow.index];
        if (!node) return null;
        const rowStyle: CSSProperties = {
          position: 'absolute',
          top: 0,
          left: 0,
          width: '100%',
          transform: `translateY(${virtualRow.start}px)`,
        };
        return (
          <div
            key={virtualRow.key}
            data-virtual-index={virtualRow.index}
            data-virtual-id={node.id}
            // `measureElement` writes the measured height into the
            // virtualizer's cache so subsequent renders use real sizes
            // (not the estimate). Must be applied to the rendered row,
            // not a wrapper, or the heights will be wrong.
            ref={virtualizer.measureElement}
            style={rowStyle}
          >
            {renderNode(node)}
          </div>
        );
      })}
    </div>
  );
}

// `forwardRef` doesn't preserve generics cleanly — the standard workaround
// is to cast the wrapped component back to a generic function type. This
// keeps `VirtualConversation<MyNode>` ergonomic at call sites while still
// letting callers grab the inner content `ref` for ResizeObserver wiring.
export const VirtualConversation = forwardRef(
  VirtualConversationInner,
) as <N extends VirtualNode>(
  props: VirtualConversationProps<N> & { ref?: Ref<HTMLDivElement> },
) => ReturnType<typeof VirtualConversationInner>;
