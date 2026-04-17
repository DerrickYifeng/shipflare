import type { ReactNode } from 'react';
import { SWRConfig } from 'swr';
import { ToastProvider } from '@/components/ui/toast';
import { PipelineProvider } from '@/components/ui/pipeline-provider';
import { Sidebar } from '@/components/layout/sidebar';
import { TopNav } from '@/components/layout/top-nav';

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <SWRConfig
      value={{
        dedupingInterval: 5_000,
        focusThrottleInterval: 10_000,
        revalidateOnFocus: false,
      }}
    >
      <ToastProvider>
        <PipelineProvider>
          <div className="flex min-h-screen bg-sf-bg-primary">
            <Sidebar />
            <div className="flex-1 flex flex-col min-w-0">
              <TopNav />
              {children}
            </div>
          </div>
        </PipelineProvider>
      </ToastProvider>
    </SWRConfig>
  );
}
