import type { ReactNode } from 'react';
import { ToastProvider } from '@/components/ui/toast';
import { PipelineProvider } from '@/components/ui/pipeline-provider';
import { AgentStreamProvider } from '@/hooks/agent-stream-provider';
import { Sidebar } from '@/components/layout/sidebar';
import { TopNav } from '@/components/layout/top-nav';

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <ToastProvider>
      <PipelineProvider>
        <AgentStreamProvider>
          <div className="flex min-h-screen bg-sf-bg-primary">
            <Sidebar />
            <div className="flex-1 flex flex-col min-w-0">
              <TopNav />
              {children}
            </div>
          </div>
        </AgentStreamProvider>
      </PipelineProvider>
    </ToastProvider>
  );
}
