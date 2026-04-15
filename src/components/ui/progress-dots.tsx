interface ProgressDotsProps {
  steps: number;
  current: number;
}

export function ProgressDots({ steps, current }: ProgressDotsProps) {
  return (
    <div className="flex items-center gap-2" role="progressbar" aria-valuenow={current + 1} aria-valuemin={1} aria-valuemax={steps}>
      {Array.from({ length: steps }, (_, i) => (
        <div
          key={i}
          className={`
            w-2 h-2 rounded-full transition-colors duration-200
            ${i === current ? 'bg-sf-accent' : i < current ? 'bg-sf-text-tertiary' : 'bg-sf-border'}
          `}
          aria-hidden="true"
        />
      ))}
    </div>
  );
}
