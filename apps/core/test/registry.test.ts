import { describe, it, expect } from 'vitest';
import { EMPLOYEE_REGISTRY, EMPLOYEE_IDS } from '../src/agents/registry';

describe('EMPLOYEE_REGISTRY', () => {
  it('contains cmo entry with required fields', () => {
    expect(EMPLOYEE_REGISTRY.cmo).toBeDefined();
    expect(EMPLOYEE_REGISTRY.cmo?.envBinding).toBe('CMO');
    expect(EMPLOYEE_REGISTRY.cmo?.displayName).toBeTruthy();
    expect(EMPLOYEE_REGISTRY.cmo?.description).toBeTruthy();
  });

  it('EMPLOYEE_IDS matches registry keys', () => {
    expect(EMPLOYEE_IDS.sort()).toEqual(Object.keys(EMPLOYEE_REGISTRY).sort());
  });
});
