'use client';

// Thin wrapper exported to page.tsx.
// The page passes server-fetched initial values; OnboardingFlow
// hydrates its own draft from the API on mount, so these props are
// accepted for API compatibility but the flow's draft hydration
// takes precedence.

import { OnboardingFlow } from './OnboardingFlow';

interface OnboardingFormProps {
  initialName?: string;
  initialUrl?: string;
  initialDescription?: string;
}

export function OnboardingForm(_props: OnboardingFormProps) {
  // OnboardingFlow hydrates from /api/onboarding-draft on mount;
  // the server-fetched initial values are superseded by that.
  return <OnboardingFlow />;
}
