import { describe, it, expect, vi } from 'vitest';
import { getEmployee } from '../src/agents/lib/get-employee';

describe('getEmployee', () => {
  it('looks up DO stub by registry envBinding', () => {
    const get = vi.fn(() => 'stub' as any);
    const idFromName = vi.fn(() => 'do_id' as any);
    const env = { CMO: { idFromName, get } } as any;
    const stub = getEmployee('cmo', 'user_1', env);
    expect(idFromName).toHaveBeenCalledWith('user_1');
    expect(get).toHaveBeenCalledWith('do_id');
    expect(stub).toBe('stub');
  });

  it('throws when employee id is unknown', () => {
    const env = {} as any;
    expect(() => getEmployee('unknown' as any, 'u', env)).toThrow(/unknown employee/i);
  });

  it('throws when env is missing the binding', () => {
    const env = {} as any;
    expect(() => getEmployee('cmo', 'u', env)).toThrow(/missing.*CMO/i);
  });
});
