import { describe, it, expect } from 'vitest';
import {
  searchSourceJobSchema,
  discoveryScanJobSchema,
} from '../types';

describe('new job schemas', () => {
  it('search-source requires source', () => {
    expect(() =>
      searchSourceJobSchema.parse({
        schemaVersion: 1,
        traceId: 't1',
        userId: 'u1',
        productId: 'p1',
        platform: 'reddit',
        scanRunId: 'scan-1',
      }),
    ).toThrow();
  });

  it('discovery-scan rejects unknown trigger', () => {
    expect(() =>
      discoveryScanJobSchema.parse({
        schemaVersion: 1,
        traceId: 't1',
        userId: 'u1',
        productId: 'p1',
        platform: 'reddit',
        scanRunId: 'scan-1',
        trigger: 'frog',
      }),
    ).toThrow();
  });

  it('accepts valid discovery-scan job', () => {
    const r = discoveryScanJobSchema.parse({
      schemaVersion: 1,
      traceId: 't1',
      userId: 'u1',
      productId: 'p1',
      platform: 'reddit',
      scanRunId: 'scan-1',
      trigger: 'manual',
    });
    // Narrow out the fanout variant to access `trigger`.
    if (r.kind === 'fanout') throw new Error('expected user variant');
    expect(r.trigger).toBe('manual');
  });

  it('accepts fanout discovery-scan job', () => {
    const r = discoveryScanJobSchema.parse({
      kind: 'fanout',
      schemaVersion: 1,
      traceId: 'cron-1',
    });
    expect(r.kind).toBe('fanout');
  });
});
