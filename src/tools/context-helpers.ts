// Shared helpers for reading deps off a ToolContext from inside a domain
// tool's `execute()` implementation. Every domain tool that lives in
// `src/tools/<Entity>Tools/` talks to the DB scoped to the current user +
// product, so they all pull the same four keys: `db`, `userId`,
// `productId`, and sometimes `teamId`.
//
// Kept small on purpose — one file, no reactivity, no observers. The pattern
// matches `SendMessageTool.readTeamContext()` but is generalized so tools
// can opt into partial dep sets.

import type { ToolContext } from '@/core/types';
import { db as defaultDb, type Database } from '@/lib/db';

/** Try a single key; return null on miss instead of throwing. */
export function tryGet<T>(ctx: ToolContext, key: string): T | null {
  try {
    return ctx.get<T>(key);
  } catch {
    return null;
  }
}

/** Required keys — throws a user-legible error when missing. */
export function requireDep<T>(ctx: ToolContext, key: string): T {
  try {
    return ctx.get<T>(key);
  } catch {
    throw new Error(
      `Domain tool context missing required dependency "${key}". ` +
        `The team-run worker injects userId/productId/db; ensure this tool ` +
        `is only called from a team run.`,
    );
  }
}

/**
 * Standard domain-tool deps bundle. Tools that need product-scoped DB reads
 * pull all four; tools that are team-scoped (query_team_status) substitute
 * teamId for productId. Every domain tool accepts an injected `db` so tests
 * can drive it against an in-memory double without touching Postgres.
 */
export interface DomainToolDeps {
  db: Database;
  userId: string;
  productId: string;
  teamId: string | null;
}

export function readDomainDeps(ctx: ToolContext): DomainToolDeps {
  return {
    db: tryGet<Database>(ctx, 'db') ?? defaultDb,
    userId: requireDep<string>(ctx, 'userId'),
    productId: requireDep<string>(ctx, 'productId'),
    teamId: tryGet<string>(ctx, 'teamId'),
  };
}

/**
 * Team-scoped variant — query_team_status only cares about the team bucket,
 * not the product. Still pulls userId for ownership assertions where the
 * table has a user_id column.
 */
export interface TeamScopedDeps {
  db: Database;
  userId: string | null;
  teamId: string;
}

export function readTeamScopedDeps(ctx: ToolContext): TeamScopedDeps {
  return {
    db: tryGet<Database>(ctx, 'db') ?? defaultDb,
    userId: tryGet<string>(ctx, 'userId'),
    teamId: requireDep<string>(ctx, 'teamId'),
  };
}
