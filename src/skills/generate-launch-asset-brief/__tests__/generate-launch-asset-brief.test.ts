import { describe, it, expect } from 'vitest';
import { launchAssetBriefOutputSchema } from '@/agents/schemas';

describe('launchAssetBriefOutputSchema', () => {
  it('accepts a minimal valid gallery_image brief', () => {
    const valid = {
      assetType: 'gallery_image',
      title: 'ShipFlare — PH gallery hero',
      brief:
        'A single hero frame showing the Today screen with 3 drafted posts awaiting approval. Tagline overlay top-right.',
      shotList: ['hero frame: Today screen with 3 drafts + tagline overlay'],
      mustInclude: ['Product UI visible', 'Tagline at top-right'],
      mustAvoid: ['Gradient background', 'Stock illustrations'],
    };
    expect(() => launchAssetBriefOutputSchema.parse(valid)).not.toThrow();
  });

  it('accepts a video_30s brief with optional inspirations', () => {
    const valid = {
      assetType: 'video_30s',
      title: 'ShipFlare — 30s launch video',
      brief:
        'Captions required; no VO. 8 beats covering hook, problem, reveal, outcomes, end card.',
      shotList: [
        '0-3s: hook frame',
        '3-8s: Monday-morning-marketing pain',
        '8-16s: product reveal',
        '16-26s: 3 outcome frames',
        '26-30s: end card',
      ],
      mustInclude: ['captions always on', 'end card with launch date'],
      mustAvoid: ['AI voiceover', 'generic B-roll'],
      referenceInspirations: [
        'https://www.producthunt.com/posts/example-launch-1',
      ],
    };
    expect(() => launchAssetBriefOutputSchema.parse(valid)).not.toThrow();
  });

  it('rejects an unknown assetType', () => {
    const invalid = {
      assetType: 'billboard',
      title: 't',
      brief: 'b'.repeat(50),
      shotList: ['one'],
      mustInclude: ['x'],
      mustAvoid: ['y'],
    };
    expect(() => launchAssetBriefOutputSchema.parse(invalid)).toThrow();
  });

  it('rejects an empty shot list', () => {
    const invalid = {
      assetType: 'og_image',
      title: 't',
      brief: 'b'.repeat(50),
      shotList: [],
      mustInclude: ['x'],
      mustAvoid: ['y'],
    };
    expect(() => launchAssetBriefOutputSchema.parse(invalid)).toThrow();
  });

  it('rejects a brief shorter than 40 chars', () => {
    const invalid = {
      assetType: 'og_image',
      title: 't',
      brief: 'short',
      shotList: ['one'],
      mustInclude: ['x'],
      mustAvoid: ['y'],
    };
    expect(() => launchAssetBriefOutputSchema.parse(invalid)).toThrow();
  });
});
