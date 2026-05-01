import { describe, it, expect } from 'vitest';
import { substituteArguments } from '@/utils/argumentSubstitution';

describe('substituteArguments', () => {
  it('replaces $ARGUMENTS with the full args string', () => {
    expect(
      substituteArguments('Echo: $ARGUMENTS, end.', 'hello world'),
    ).toBe('Echo: hello world, end.');
  });

  it('replaces $0 / $1 with positional args', () => {
    expect(substituteArguments('first=$0 second=$1', 'a b')).toBe(
      'first=a second=b',
    );
  });

  it('returns body unchanged when no placeholders and no args', () => {
    expect(substituteArguments('plain body', '')).toBe('plain body');
  });

  it('appends ARGUMENTS line when no placeholder but args provided', () => {
    expect(substituteArguments('plain body', 'extra')).toBe(
      'plain body\n\nARGUMENTS: extra',
    );
  });

  it('replaces multiple $ARGUMENTS occurrences', () => {
    expect(
      substituteArguments('a=$ARGUMENTS b=$ARGUMENTS', 'x'),
    ).toBe('a=x b=x');
  });

  it('handles missing positional gracefully', () => {
    expect(substituteArguments('first=$0 second=$1', 'only')).toBe(
      'first=only second=',
    );
  });

  it('is pure across consecutive calls (no global regex state leaks)', () => {
    // Call once with body that ends in $ARGUMENTS — would advance lastIndex
    // if the regex were stateful.
    const first = substituteArguments('prefix here $ARGUMENTS', 'A');
    // Call again with body where $ARGUMENTS is at index 0 — would fail
    // if lastIndex from the first call is still > 0.
    const second = substituteArguments('$ARGUMENTS suffix', 'B');
    expect(first).toBe('prefix here A');
    expect(second).toBe('B suffix');
  });

  it('handles empty args with placeholder by substituting empty string', () => {
    expect(substituteArguments('hi $ARGUMENTS', '')).toBe('hi ');
    expect(substituteArguments('first=$0', '')).toBe('first=');
  });

  it('preserves $ARGUMENTS_FOO style identifiers (\\b boundary)', () => {
    // Word-boundary regex must NOT replace $ARGUMENTS when followed by
    // word chars. Skill authors writing $ARGUMENTS_FOO must get literal
    // $ARGUMENTS_FOO, not <args>_FOO.
    expect(substituteArguments('use $ARGUMENTS_FOO directly', 'x')).toBe(
      'use $ARGUMENTS_FOO directly\n\nARGUMENTS: x',
    );
  });
});
