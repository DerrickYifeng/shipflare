// Resolves AgentDefinition `requires:` DSL strings against current team /
// product state. Today the DSL is intentionally narrow:
//   - `channel:<id>`              — connected platform (x, reddit, ...)
//   - `product:has_description`   — products.description IS NOT NULL
//
// Phase A: parser + evaluator with TeamFacts injection (no DB access).
// Phase B/E will add a DB-backed fact loader and use this in dynamic
// team-roster injection.

export type Requirement =
  | { kind: 'channel'; value: string }
  | { kind: 'product'; value: string };

/** In-memory snapshot of team / product facts the resolver evaluates against. */
export interface TeamFacts {
  /** Connected channel ids (set of platform identifiers, e.g. 'x', 'reddit'). */
  channels: ReadonlySet<string>;
  /** True when the team's product has a non-empty description. */
  productHasDescription: boolean;
}

const KNOWN_KINDS = new Set(['channel', 'product']);

export function parseRequirement(raw: string): Requirement {
  const colon = raw.indexOf(':');
  if (colon === -1) {
    throw new Error(`requires entry "${raw}" is missing a colon (expected "kind:value")`);
  }
  const kind = raw.slice(0, colon).trim();
  const value = raw.slice(colon + 1).trim();
  if (!KNOWN_KINDS.has(kind)) {
    throw new Error(
      `requires entry "${raw}" has unknown prefix "${kind}" (expected one of: ${Array.from(KNOWN_KINDS).join(', ')})`,
    );
  }
  return { kind: kind as Requirement['kind'], value };
}

export function evaluateRequirement(req: Requirement, facts: TeamFacts): boolean {
  switch (req.kind) {
    case 'channel':
      return facts.channels.has(req.value);
    case 'product':
      if (req.value === 'has_description') return facts.productHasDescription;
      throw new Error(`unknown product predicate: "${req.value}"`);
  }
}

export function evaluateAllRequirements(
  requires: readonly string[],
  facts: TeamFacts,
): boolean {
  return requires.every((r) => evaluateRequirement(parseRequirement(r), facts));
}
