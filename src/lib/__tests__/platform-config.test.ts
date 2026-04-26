import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PLATFORMS,
  getPlatformCharLimits,
  getPlatformConfig,
  isPlatformAvailable,
  listAvailablePlatforms,
  listPlatforms,
} from '../platform-config';

describe('platform-config', () => {
  const originalEnabled = {
    reddit: PLATFORMS.reddit.enabled,
    x: PLATFORMS.x.enabled,
  };
  const originalXaiKey = process.env.XAI_API_KEY;

  beforeEach(() => {
    process.env.XAI_API_KEY = 'test-key';
  });

  afterEach(() => {
    PLATFORMS.reddit.enabled = originalEnabled.reddit;
    PLATFORMS.x.enabled = originalEnabled.x;
    if (originalXaiKey === undefined) delete process.env.XAI_API_KEY;
    else process.env.XAI_API_KEY = originalXaiKey;
  });

  describe('registry shape', () => {
    it('carries enabled + maxCharLength for every platform', () => {
      for (const id of listPlatforms()) {
        const cfg = getPlatformConfig(id);
        expect(typeof cfg.enabled).toBe('boolean');
        expect(cfg.maxCharLength).toMatchObject({
          post: expect.any(Number),
          reply: expect.any(Number),
        });
        expect(cfg.maxCharLength.post).toBeGreaterThan(0);
        expect(cfg.maxCharLength.reply).toBeGreaterThan(0);
      }
    });

    it('ships MVP defaults: Reddit disabled, X enabled', () => {
      expect(PLATFORMS.reddit.enabled).toBe(false);
      expect(PLATFORMS.x.enabled).toBe(true);
    });

    it('uses the X caps the validator pipeline expects', () => {
      // Both kinds share X's 280 platform cap; stylistic targets (e.g.
      // "aim for 40-140 on a reply") live in agent prose, not here.
      expect(PLATFORMS.x.maxCharLength.post).toBe(280);
      expect(PLATFORMS.x.maxCharLength.reply).toBe(280);
    });

    it('keeps Reddit in the registry so workers/schema still resolve it', () => {
      expect(PLATFORMS.reddit).toBeDefined();
      expect(PLATFORMS.reddit.maxCharLength.post).toBe(40_000);
      expect(PLATFORMS.reddit.maxCharLength.reply).toBe(10_000);
    });
  });

  describe('isPlatformAvailable', () => {
    it('returns true for an enabled platform with its env guard satisfied', () => {
      expect(isPlatformAvailable('x')).toBe(true);
    });

    it('returns false for a registered-but-disabled platform', () => {
      expect(isPlatformAvailable('reddit')).toBe(false);
    });

    it('returns false when an enabled platform is missing its env guard', () => {
      delete process.env.XAI_API_KEY;
      expect(isPlatformAvailable('x')).toBe(false);
    });

    it('returns true when a platform is toggled back on', () => {
      PLATFORMS.reddit.enabled = true;
      expect(isPlatformAvailable('reddit')).toBe(true);
    });

    it('returns false for an unknown platform', () => {
      expect(isPlatformAvailable('linkedin')).toBe(false);
    });
  });

  describe('listAvailablePlatforms', () => {
    it('omits disabled platforms while keeping them in listPlatforms()', () => {
      expect(listPlatforms()).toContain('reddit');
      expect(listAvailablePlatforms()).not.toContain('reddit');
      expect(listAvailablePlatforms()).toContain('x');
    });
  });

  describe('getPlatformCharLimits', () => {
    it('returns the post cap for post kind', () => {
      expect(getPlatformCharLimits('x', 'post')).toBe(280);
      expect(getPlatformCharLimits('reddit', 'post')).toBe(40_000);
    });

    it('returns the reply cap for reply kind', () => {
      expect(getPlatformCharLimits('x', 'reply')).toBe(240);
      expect(getPlatformCharLimits('reddit', 'reply')).toBe(10_000);
    });

    it('throws on an unknown platform', () => {
      expect(() => getPlatformCharLimits('linkedin', 'post')).toThrow(
        /Unknown platform/,
      );
    });
  });
});
