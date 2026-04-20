import { redirect } from 'next/navigation';

/**
 * `/automation` is superseded by `/team` (v2 frontend migration, Phase 6).
 * Preserve old bookmarks/links by redirecting permanently to the new route.
 * See TODOS.md — Phase 6 for the rationale; the isometric Your AI Team
 * scene replaces the previous `AgentsWarRoom` grid.
 */
export default function AutomationRedirectPage() {
  redirect('/team');
}
