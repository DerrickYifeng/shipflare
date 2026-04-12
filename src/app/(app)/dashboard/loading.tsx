import { Skeleton } from '@/components/ui/skeleton';

export default function DashboardLoading() {
  return (
    <div className="flex flex-col flex-1">
      {/* Header skeleton */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-sf-border">
        <Skeleton className="h-6 w-32" />
        <Skeleton className="h-9 w-9 rounded-full" />
      </div>

      <div className="flex-1 flex flex-col lg:flex-row">
        <div className="lg:w-3/5 p-4 border-r border-sf-border">
          <Skeleton className="h-4 w-24 mb-3" />
          <div className="flex flex-col gap-2">
            <Skeleton className="h-48 w-full" />
            <Skeleton className="h-48 w-full" />
          </div>
        </div>
        <div className="lg:w-2/5 p-4">
          <Skeleton className="h-4 w-20 mb-3" />
          <div className="flex flex-col gap-1">
            {Array.from({ length: 5 }, (_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        </div>
      </div>

      <div className="border-t border-sf-border h-[140px] p-4">
        <Skeleton className="h-4 w-16 mb-2" />
        <Skeleton className="h-16 w-full" />
      </div>
    </div>
  );
}
