// Copy strings locked per frontend spec §13.
// Single module so future i18n is a one-file diff.

export type StepIndex = 0 | 1 | 2 | 3;

export interface RailStep {
  readonly label: string;
  readonly detail: string;
}

export const COPY = {
  rail: {
    header: 'ShipFlare',
    meta: (step: number) => `Setup · ${step + 1} of 4`,
    steps: [
      {
        label: 'Add your product',
        detail:
          "We'll scan your repo or site to extract name, description, and keywords.",
      },
      {
        label: 'Connect your accounts',
        detail:
          'So ShipFlare can draft replies and schedule posts on your behalf.',
      },
      {
        label: "Where's your product at?",
        detail:
          'This decides whether we generate a pre-launch playbook or a compound plan.',
      },
      {
        label: 'Your launch plan',
        detail:
          'Your calibrated plan — product, timeline, and first-week tasks.',
      },
    ] as readonly RailStep[],
    footerStatus: '6 agents ready',
  },
  // TODO: Phase 12 — stage-specific copy (source/scanning/review/connect/state/plan)
} as const;
