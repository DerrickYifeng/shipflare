import { describe, expect, it } from 'vitest';
import { validateHumilityTells } from '../editorial';

describe('validateHumilityTells', () => {
  describe('corrective-opener', () => {
    it('flags "the real X is Y"', () => {
      const r = validateHumilityTells('The real cost is context switching');
      expect(r.ok).toBe(false);
      expect(r.hits[0]!.pattern).toBe('corrective-opener');
    });

    it('flags "X isn\'t Y. it\'s Z"', () => {
      const r = validateHumilityTells(
        "Marketing debt isn't a time problem. It's a tooling problem.",
      );
      expect(r.ok).toBe(false);
      expect(r.hits.some((h) => h.pattern === 'corrective-opener')).toBe(true);
    });

    it('flags "X isn\'t Y — it\'s Z"', () => {
      const r = validateHumilityTells(
        "The gap isn't the skills—it's that builders optimize for depth",
      );
      expect(r.ok).toBe(false);
      expect(r.hits.some((h) => h.pattern === 'corrective-opener')).toBe(true);
    });

    it('flags "the real X isn\'t Y"', () => {
      const r = validateHumilityTells(
        "The real constraint isn't time—it's context switching.",
      );
      expect(r.ok).toBe(false);
      expect(r.hits.some((h) => h.pattern === 'corrective-opener')).toBe(true);
    });
  });

  describe('coach-voice', () => {
    it('flags "Winners do X"', () => {
      const r = validateHumilityTells(
        'Winners post bad content, ship, measure what sticks',
      );
      expect(r.ok).toBe(false);
      expect(r.hits[0]!.pattern).toBe('coach-voice');
    });

    it('flags "Winners aren\'t"', () => {
      const r = validateHumilityTells(
        "Winners aren't trying to be copywriters; they're automating",
      );
      expect(r.ok).toBe(false);
      expect(r.hits.some((h) => h.pattern === 'coach-voice')).toBe(true);
    });

    it('flags "Most solo devs"', () => {
      const r = validateHumilityTells(
        "Most solo devs don't measure anything",
      );
      expect(r.ok).toBe(false);
      expect(r.hits.some((h) => h.pattern === 'coach-voice')).toBe(true);
    });
  });

  describe('imperative-prescription', () => {
    it('flags "You need 1 metric"', () => {
      const r = validateHumilityTells(
        'You need 1 metric: replies (signal), clicks (reach)',
      );
      expect(r.ok).toBe(false);
      expect(r.hits.some((h) => h.pattern === 'imperative-prescription')).toBe(
        true,
      );
    });

    it('flags "Pick 1"', () => {
      const r = validateHumilityTells('Pick 1 and watch it.');
      expect(r.ok).toBe(false);
      expect(r.hits.some((h) => h.pattern === 'imperative-prescription')).toBe(
        true,
      );
    });

    it('flags "Measure something"', () => {
      const r = validateHumilityTells(
        'Most post blind. Measure something.',
      );
      expect(r.ok).toBe(false);
      expect(r.hits.some((h) => h.pattern === 'imperative-prescription')).toBe(
        true,
      );
    });
  });

  describe('peer-voice passes', () => {
    it('lets "we tried X for N weeks" through', () => {
      expect(
        validateHumilityTells(
          'we tried Stripe Tax for 14 days, broke at one edge case',
        ).ok,
      ).toBe(true);
    });

    it('lets vulnerable first-person framing through', () => {
      expect(
        validateHumilityTells(
          'first churn at month 8 hurt more than I expected',
        ).ok,
      ).toBe(true);
    });

    it('lets a question through', () => {
      expect(
        validateHumilityTells(
          "huge. what's the channel that finally clicked?",
        ).ok,
      ).toBe(true);
    });

    it('lets specific anecdote through', () => {
      expect(
        validateHumilityTells(
          'shipped revenue analytics yesterday — first user spotted a $1,247 leak in 4 minutes',
        ).ok,
      ).toBe(true);
    });
  });

  describe('production backtest', () => {
    // The 8 monitor-driven reply drafts pulled from prod 2026-04-30.
    // Documents which of the smug-sounding live drafts the regex catches.
    // See PR notes for the full diagnosis.
    const productionDrafts: Array<{ body: string; expectFlag: boolean }> = [
      {
        // Subtler phrasing — relies on prompt rules, not regex.
        body: "0→1 doesn't need budget, just consistency. 1 post per day for 60 days = 60 shots at being found. The budget trap: thinking you need to buy audience vs earning it through signal.",
        expectFlag: false,
      },
      {
        // "is the real cost" word order — ALSO subtle.
        body: 'Context switch is the real cost, not hype—just the overhead of 2 modes. Builders think systems; marketers think distribution.',
        expectFlag: false,
      },
      {
        body: 'Post → silence → spiral. You need 1 metric: replies (signal), clicks (reach), saves (value). Pick 1 and watch it. Most post blind. Measure something.',
        expectFlag: true, // imperative-prescription × multiple
      },
      {
        body: "The gap isn't the skills—it's that builders optimize for depth and marketing demands breadth.",
        expectFlag: true, // corrective-opener
      },
      {
        body: "Good code gets marginally better with optimization. Good marketing is a different skill. Winners aren't trying to be copywriters; they're automating that part so they stay in code.",
        expectFlag: true, // coach-voice
      },
      {
        body: 'Winners post bad content, ship, measure what sticks, iterate. 3 impressions → 30 → 300.',
        expectFlag: true, // coach-voice
      },
      {
        body: "The real constraint isn't time—it's context switching. Most solo devs solve this by defaulting to one, then burning out.",
        expectFlag: true, // corrective-opener + coach-voice
      },
      {
        body: "The test itself becomes part of your marketing. You're not just learning if people want it—you're building in public, so the learning IS the content.",
        expectFlag: true, // corrective-opener (not just X — Y)
      },
    ];

    it('flags ≥ 6 of 8 production drafts (≥75% recall)', () => {
      const flagged = productionDrafts.filter(
        (d) => !validateHumilityTells(d.body).ok,
      );
      expect(flagged.length).toBeGreaterThanOrEqual(6);
    });

    it('matches the documented expectation per draft', () => {
      for (const d of productionDrafts) {
        const r = validateHumilityTells(d.body);
        expect(
          { body: d.body.slice(0, 60), flagged: !r.ok },
        ).toEqual({ body: d.body.slice(0, 60), flagged: d.expectFlag });
      }
    });
  });
});
