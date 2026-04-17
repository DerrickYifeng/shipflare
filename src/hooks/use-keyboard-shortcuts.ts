'use client';

import { useEffect } from 'react';

/**
 * Generic keyboard shortcut binder.
 *
 * - Binds a single `keydown` listener on `window` and dispatches to the
 *   matching handler by `event.key`.
 * - Ignores events originating from text inputs (`<input>`, `<textarea>`,
 *   `contenteditable`) so typing in an edit field never fires shortcuts.
 * - Respects modifier keys: skips when `ctrlKey`, `metaKey`, or `altKey`
 *   is held (so browser shortcuts like Cmd+K are unaffected).
 *
 * @param shortcuts  Map of single-key bindings, e.g. `{ j: next, k: prev }`.
 * @param deps       Optional dependency list — pass changing values (e.g.
 *                   the currently-selected id) so the handlers close over
 *                   fresh state. Defaults to rebinding on every render.
 */
export function useKeyboardShortcuts(
  shortcuts: Record<string, () => void>,
  deps: unknown[] = [],
): void {
  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      // Skip when the user is typing in an editable surface.
      const target = event.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (
          tag === 'INPUT' ||
          tag === 'TEXTAREA' ||
          tag === 'SELECT' ||
          target.isContentEditable
        ) {
          return;
        }
      }

      // Skip chorded shortcuts — we only handle bare single-key bindings.
      if (event.ctrlKey || event.metaKey || event.altKey) return;

      const action = shortcuts[event.key];
      if (!action) return;

      event.preventDefault();
      action();
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
