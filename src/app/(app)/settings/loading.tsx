import { Skeleton } from '@/components/ui/skeleton';

export default function SettingsLoading() {
  return (
    <div className="flex flex-col flex-1">
      <div className="flex items-center justify-between px-6 py-4 border-b border-sf-border">
        <Skeleton className="h-6 w-28" />
        <Skeleton className="h-9 w-9 rounded-full" />
      </div>
      <div className="max-w-[640px] mx-auto p-6 flex flex-col gap-8 w-full">
        {Array.from({ length: 5 }, (_, i) => (
          <section key={i}>
            <Skeleton className="h-6 w-40 mb-4" />
            <Skeleton className="h-24 w-full" />
          </section>
        ))}
      </div>
    </div>
  );
}
