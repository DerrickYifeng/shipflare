import { describe, it, expect } from 'vitest';
import { discoveryScanJobSchema } from '../types';

describe('job schemas', () => {
  it('accepts fanout discovery-scan job', () => {
    const r = discoveryScanJobSchema.parse({
      kind: 'fanout',
      schemaVersion: 1,
      traceId: 'cron-1',
    });
    expect(r.kind).toBe('fanout');
  });

  it('rejects discovery-scan jobs missing the fanout discriminator', () => {
    expect(() =>
      discoveryScanJobSchema.parse({
        schemaVersion: 1,
        traceId: 't1',
      }),
    ).toThrow();
  });
});
