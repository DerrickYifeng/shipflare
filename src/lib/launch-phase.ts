export type ProductState = 'mvp' | 'launching' | 'launched';

export type LaunchPhase =
  | 'foundation'
  | 'audience'
  | 'momentum'
  | 'launch'
  | 'compound'
  | 'steady';

export interface DerivePhaseInput {
  state: ProductState;
  launchDate: Date | null;
  launchedAt: Date | null;
  now?: Date;
}

const MS_PER_DAY = 86_400_000;

export function derivePhase(input: DerivePhaseInput): LaunchPhase {
  const now = input.now ?? new Date();

  if (input.state === 'launched') {
    if (!input.launchedAt) return 'steady';
    const daysSince = (now.getTime() - input.launchedAt.getTime()) / MS_PER_DAY;
    return daysSince <= 30 ? 'compound' : 'steady';
  }

  if (!input.launchDate) return 'foundation';

  const daysToLaunch = (input.launchDate.getTime() - now.getTime()) / MS_PER_DAY;
  if (daysToLaunch <= 0) return 'launch';
  if (daysToLaunch <= 7) return 'momentum';
  if (daysToLaunch <= 28) return 'audience';
  return 'foundation';
}
