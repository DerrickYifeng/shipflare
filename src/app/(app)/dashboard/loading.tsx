import { Skeleton } from '@/components/ui/skeleton';

export default function DashboardLoading() {
  return (
    <div className="flex flex-col flex-1">
      <div className="flex items-center justify-between px-6 py-5">
        <Skeleton className="h-7 w-32" />
      </div>
      <div className="flex-1 p-6 flex flex-col gap-6 max-w-4xl">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-48 w-full" />
      </div>
    </div>
  );
}
