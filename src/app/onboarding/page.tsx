'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ProgressDots } from '@/components/ui/progress-dots';
import { ProductSourceStep } from '@/components/onboarding/product-source-step';
import { ProfileReviewStep } from '@/components/onboarding/profile-review-step';
import { ConnectAccountsStep } from '@/components/onboarding/connect-accounts-step';
import { activatePostOnboarding } from '@/app/actions/activation';
import type { ExtractedProfile } from '@/types/onboarding';

export default function OnboardingPage() {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [profile, setProfile] = useState<ExtractedProfile | null>(null);

  const handleExtracted = (data: ExtractedProfile) => {
    setProfile(data);
    setStep(1);
  };

  const handleProfileSaved = () => {
    setStep(2);
  };

  const handleComplete = async () => {
    // Fire-and-forget from the user's perspective — the server action
    // enqueues calendar-plan jobs per connected platform; failures are
    // logged server-side but must not block navigation to /today.
    try {
      await activatePostOnboarding();
    } catch {
      // Swallowed: the Today page surfaces empty/error states on its own.
    }
    router.push('/today');
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-[21px] font-semibold text-sf-text-primary tracking-[0.231px] leading-[1.19]">
          {step === 0 && 'Add your product'}
          {step === 1 && 'Review your profile'}
          {step === 2 && 'Connect your accounts'}
        </h1>
        <ProgressDots steps={3} current={step} />
      </div>

      {step === 0 && <ProductSourceStep onExtracted={handleExtracted} />}
      {step === 1 && profile && (
        <ProfileReviewStep
          profile={profile}
          onSaved={handleProfileSaved}
          onBack={() => setStep(0)}
        />
      )}
      {step === 2 && (
        <ConnectAccountsStep
          onComplete={handleComplete}
          onBack={() => setStep(1)}
        />
      )}
    </div>
  );
}
