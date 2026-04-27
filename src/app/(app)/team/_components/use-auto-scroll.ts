'use client';

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

export interface UseAutoScrollOptions {
  /**
   * Ref to the scroll container — the element with `overflow-y: auto`.
   * Must be stable across renders (it is if created with `useRef`).
   */
  containerRef: RefObject<HTMLElement | null>;
  /**
   * Ref to the content element inside the container. A `ResizeObserver`
   * watches this for size changes during streaming — every token append
   * fires it, which is what keeps auto-scroll locked to the bottom even
   * while React's concurrent scheduler defers renders.
   */
  contentRef: RefObject<HTMLElement | null>;
}

export interface UseAutoScrollResult {
  /** Whether the user is considered "at the bottom" of the scroll region. */
  paused: boolean;
  /** Force scroll to the sentinel — used by the "Jump to latest" pill. */
  jumpToBottom: () => void;
  /**
   * Break out of sticky-tail without scrolling. Used by the
   * task-focus flow so ResizeObserver doesn't re-pin to the bottom
   * after we've scrolled to a specific SubtaskCard.
   */
  unstick: () => void;
}

// `use-stick-to-bottom`'s constant. Sub-pixel scroll math plus layout
// rounding make strict equality miss; 70px gives enough headroom that a
// token or two of new content doesn't flip stickiness off.
const NEAR_BOTTOM_PX = 70;

/**
 * Streaming-safe auto-scroll. Replaces the old sentinel +
 * `scrollIntoView({behavior:'smooth'})` combo — that pair is the classic
 * failure mode where each new delta cancels the in-flight smooth
 * animation and you never actually reach the bottom (see
 * https://github.com/stackblitz-labs/use-stick-to-bottom and
 * https://bugzilla.mozilla.org/show_bug.cgi?id=1139745).
 *
 * Design, borrowed wholesale from `use-stick-to-bottom`:
 *   - **ResizeObserver on content**: fires for every DOM growth from any
 *     React path (deferred, transition, or sync) so we react to the
 *     actual layout, not React's render cycle.
 *   - **Threshold check** (`scrollHeight - clientHeight - scrollTop
 *     <= NEAR_BOTTOM_PX`): robust across sub-pixel layouts and streaming
 *     grow-by-one-line cadences.
 *   - **Imperative `scrollTop = scrollHeight`**: instant, uninterruptible,
 *     no animation fighting subsequent deltas.
 *   - **`ignoreScrollTop` ref**: lets us distinguish our own scroll
 *     writes from genuine user input without debouncing, so the "user
 *     scrolled up, pause auto-scroll" transition fires on the first
 *     real gesture.
 */
export function useAutoScroll({
  containerRef,
  contentRef,
}: UseAutoScrollOptions): UseAutoScrollResult {
  const [paused, setPaused] = useState(false);
  // Keep the live "at bottom" decision on a ref so the ResizeObserver's
  // synchronous callback never races React state.
  const stickRef = useRef(true);
  // Our most recent programmatic scrollTop. The scroll event handler
  // compares against it to tell self-scrolls apart from user gestures.
  const ignoreScrollTopRef = useRef<number>(-1);

  const isAtBottom = useCallback((el: HTMLElement): boolean => {
    return el.scrollHeight - el.clientHeight - el.scrollTop <= NEAR_BOTTOM_PX;
  }, []);

  const scrollToBottom = useCallback((): void => {
    const el = containerRef.current;
    if (!el) return;
    const target = el.scrollHeight;
    el.scrollTop = target;
    // Remember what we wrote so the scroll event doesn't misread it as a
    // user gesture. Stored post-write because some browsers clamp
    // `scrollTop` to `scrollHeight - clientHeight` and we want the
    // clamped value.
    ignoreScrollTopRef.current = el.scrollTop;
  }, [containerRef]);

  const jumpToBottom = useCallback((): void => {
    stickRef.current = true;
    setPaused(false);
    scrollToBottom();
  }, [scrollToBottom]);

  /**
   * Break out of the sticky-tail state without scrolling anywhere. The
   * task-focus flow uses this before performing its own
   * `scrollIntoView({ block: 'center' })` so the ResizeObserver below
   * doesn't immediately re-pin to the bottom as new session content
   * paints in.
   */
  const unstick = useCallback((): void => {
    stickRef.current = false;
    setPaused(true);
  }, []);

  // Detect user-initiated scrolls. A gesture that moves away from the
  // bottom un-sticks; a gesture that lands back at the bottom re-sticks.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onScroll = (): void => {
      if (ignoreScrollTopRef.current === el.scrollTop) {
        ignoreScrollTopRef.current = -1;
        return;
      }
      const atBottom = isAtBottom(el);
      stickRef.current = atBottom;
      setPaused(!atBottom);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [containerRef, isAtBottom]);

  // Core auto-scroll engine. A ResizeObserver on the content element
  // fires on every grow — streaming tokens, lazy-loaded images, new
  // messages, anything that expands `scrollHeight`. While the user is
  // "stuck" to the bottom, we pin `scrollTop` to the new `scrollHeight`
  // synchronously. If they've scrolled up we leave them alone.
  useEffect(() => {
    const scroller = containerRef.current;
    const content = contentRef.current;
    if (!scroller || !content) return;
    if (typeof ResizeObserver === 'undefined') {
      // Fallback for ancient runtimes — just pin on mount.
      scrollToBottom();
      return;
    }
    const ro = new ResizeObserver(() => {
      if (!stickRef.current) return;
      scrollToBottom();
    });
    ro.observe(content);
    // Initial pin — the first render may have already populated content.
    if (stickRef.current) scrollToBottom();
    return () => ro.disconnect();
  }, [containerRef, contentRef, scrollToBottom]);

  return { paused, jumpToBottom, unstick };
}
