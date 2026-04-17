import { Skeleton } from '@/components/ui/skeleton';

export default function CalendarLoading() {
  return (
    <div className="flex flex-col flex-1">
      {/* Header skeleton */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-sf-border">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-9 w-9 rounded-full" />
      </div>

      <div className="flex-1 p-6">
        {/* Filter pills */}
        <div className="flex items-center gap-1 mb-6">
          <Skeleton className="h-8 w-24" />
          <Skeleton className="h-8 w-16" />
        </div>

        {/* Insights panel */}
        <Skeleton className="h-28 w-full mb-6" />

        {/* Generate button row */}
        <div className="flex items-center justify-between mb-4">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-10 w-36" />
        </div>

        {/* Day groups */}
        <div className="flex flex-col gap-4">
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i}>
              <Skeleton className="h-4 w-24 mb-2" />
              <div className="flex flex-col gap-1.5">
                <Skeleton className="h-14 w-full" />
                <Skeleton className="h-14 w-full" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
