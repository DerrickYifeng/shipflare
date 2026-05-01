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
});
