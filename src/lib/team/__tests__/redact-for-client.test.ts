import { describe, expect, it } from 'vitest';
import {
  publicToolLabel,
  publicAgentLabel,
  publicSkillLabel,
  redactMetadataForClient,
  redactContentBlocksForClient,
  redactMessageRowForClient,
} from '../redact-for-client';

describe('redact-for-client module exports', () => {
  it('exports six functions', () => {
    expect(typeof publicToolLabel).toBe('function');
    expect(typeof publicAgentLabel).toBe('function');
    expect(typeof publicSkillLabel).toBe('function');
    expect(typeof redactMetadataForClient).toBe('function');
    expect(typeof redactContentBlocksForClient).toBe('function');
    expect(typeof redactMessageRowForClient).toBe('function');
  });
});
