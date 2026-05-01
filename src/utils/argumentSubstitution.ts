// Port from engine/utils/argumentSubstitution.ts, simplified.
//
// Stripped from CC engine version:
// - Named-args mapping ($foo → argumentNames lookup): not used by Phase 1 skills
// - Shell-quote parsing (try-parse-shell-command): args arrive already split
//   by SkillTool's caller, so plain whitespace split is sufficient
//
// Keeps:
// - $ARGUMENTS full-string replacement
// - $0 / $1 positional replacement
// - "append ARGUMENTS line" fallback when no placeholder

const ARGUMENTS_PLACEHOLDER = /\$ARGUMENTS\b/g;
const POSITIONAL_PLACEHOLDER = /\$(\d+)\b/g;

function parseArguments(args: string): string[] {
  const trimmed = args.trim();
  if (trimmed === '') return [];
  return trimmed.split(/\s+/);
}

/**
 * Substitute $ARGUMENTS / $0 / $1 / ... in `body` with values from `args`.
 *
 * If `body` contains no placeholders and `args` is non-empty, appends
 * `\n\nARGUMENTS: <args>` so the model still sees them. This matches
 * CC engine behaviour and makes skills argument-passing-friendly even
 * when authors forget to add a placeholder.
 */
export function substituteArguments(body: string, args: string): string {
  const parsed = parseArguments(args);
  let result = body;
  let placeholderFound = false;

  if (ARGUMENTS_PLACEHOLDER.test(result)) {
    placeholderFound = true;
    result = result.replace(ARGUMENTS_PLACEHOLDER, args);
  }

  if (POSITIONAL_PLACEHOLDER.test(result)) {
    placeholderFound = true;
    result = result.replace(POSITIONAL_PLACEHOLDER, (_match, idx: string) => {
      const i = Number(idx);
      return parsed[i] ?? '';
    });
  }

  if (!placeholderFound && args.trim() !== '') {
    return `${result}\n\nARGUMENTS: ${args}`;
  }
  return result;
}
