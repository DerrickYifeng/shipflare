import { Skeleton } from '@/components/ui/skeleton';

export default function TodayLoading() {
  return (
    <div className="flex flex-col flex-1">
      {/* Header skeleton */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-sf-border">
        <Skeleton className="h-6 w-24" />
        <Skeleton className="h-9 w-9 rounded-full" />
      </div>

      {/* Todo list skeleton */}
      <div className="p-4 lg:p-6 max-w-2xl">
        {/* Group header */}
        <Skeleton className="h-4 w-32 mb-3" />
        <div className="flex flex-col gap-3">
          {Array.from({ length: 3 }, (_, i) => (
            <div
              key={i}
              className="border border-sf-border rounded-[var(--radius-sf-lg)] p-4"
            >
              <div className="flex items-center gap-2 mb-3">
                <Skeleton className="h-4 w-8" />
                <Skeleton className="h-5 w-16 rounded-full" />
                <Skeleton className="h-5 w-20 rounded-full" />
              </div>
              <Skeleton className="h-4 w-3/4 mb-2" />
              <Skeleton className="h-20 w-full mb-3" />
              <div className="flex gap-2">
                <Skeleton className="h-8 w-20" />
                <Skeleton className="h-8 w-16" />
                <Skeleton className="h-8 w-14" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
