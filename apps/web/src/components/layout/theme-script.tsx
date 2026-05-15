/**
 * Server-rendered pre-paint theme script.
 *
 * Lives in its OWN module (no `'use client'`) so React renders the <script>
 * tag during SSR and the browser executes it before hydration. If this lived
 * inside a client module, React 19 would skip the script tag during client
 * render and emit "Scripts inside React components are never executed when
 * rendering on the client."
 *
 * The script seeds `document.documentElement.dataset.sfTheme` from
 * localStorage so the React tree can read the right initial theme on its
 * first render and avoid hydration mismatches downstream.
 *
 * Keep the storage key in sync with `theme-provider.tsx`.
 */

const STORAGE_KEY = 'sf-theme';

const SCRIPT = `
(function () {
  try {
    var stored = localStorage.getItem('${STORAGE_KEY}');
    var theme = stored === 'dark' || stored === 'light' ? stored : 'light';
    document.documentElement.dataset.sfTheme = theme;
  } catch (e) {
    document.documentElement.dataset.sfTheme = 'light';
  }
})();`.trim();

export function ThemeScript() {
  return <script dangerouslySetInnerHTML={{ __html: SCRIPT }} />;
}
