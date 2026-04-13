'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ProgressDots } from '@/components/ui/progress-dots';
import { ProductSourceStep } from '@/components/onboarding/product-source-step';
import { ProfileReviewStep } from '@/components/onboarding/profile-review-step';
import { ConnectAccountsStep } from '@/components/onboarding/connect-accounts-step';
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

  const handleComplete = () => {
    router.push('/dashboard');
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-[18px] font-semibold text-sf-text-primary">
          {step === 0 && 'Add your product'}
          {step === 1 && 'Review your profile'}
          {step === 2 && 'Connect your accounts'}
        </h1>
        <ProgressDots steps={3} current={step} />
      </div>

      {step === 0 && <ProductSourceStep onExtracted={handleExtracted} />}
      {step === 1 && profile && (
        <ProfileReviewStep profile={profile} onSaved={handleProfileSaved} />
      )}
      {step === 2 && <ConnectAccountsStep onComplete={handleComplete} />}
    </div>
  );
}
