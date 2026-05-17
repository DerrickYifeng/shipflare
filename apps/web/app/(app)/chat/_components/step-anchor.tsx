"use client";

interface StepData {
  label: string;
  stepId: string;
}

export function StepAnchor({ part }: { part: { data: StepData } }) {
  return (
    <div
      data-testid="step-anchor"
      id={`step-${part.data.stepId}`}
      className="text-xs font-semibold text-primary my-2"
    >
      {part.data.label}
    </div>
  );
}
