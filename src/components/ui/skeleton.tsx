interface SkeletonProps {
  className?: string;
}

export function Skeleton({ className = '' }: SkeletonProps) {
  return (
    <div
      className={`animate-sf-pulse bg-black/[0.05] rounded-[var(--radius-sf-md)] ${className}`}
      aria-hidden="true"
    />
  );
}
