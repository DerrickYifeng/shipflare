interface SkeletonProps {
  className?: string;
}

export function Skeleton({ className = '' }: SkeletonProps) {
  return (
    <div
      className={`animate-sf-pulse bg-sf-bg-tertiary rounded-[var(--radius-sf-md)] ${className}`}
      aria-hidden="true"
    />
  );
}
