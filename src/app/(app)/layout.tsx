import type { ReactNode } from 'react';
import { SWRConfig } from 'swr';
import { auth } from '@/lib/auth';
import { ToastProvider } from '@/components/ui/toast';
import { PipelineProvider } from '@/components/ui/pipeline-provider';
import { ThemeProvider } from '@/components/layout/theme-provider';
import { AppShell, AppCanvas } from '@/components/layout/app-shell';
import { Sidebar } from '@/components/layout/sidebar';
import { TopNav } from '@/components/layout/top-nav';

export default async function AppLayout({ children }: { children: ReactNode }) {
  // Pages handle their own auth redirects; the layout just uses the session
  // (if any) to populate the sidebar's user card. Falling back to nulls when
  // the session is absent keeps the shell renderable during redirect flashes.
  const session = await auth();
  const user = {
    name: session?.user?.name ?? null,
    email: session?.user?.email ?? null,
    image: session?.user?.image ?? null,
  };

  return (
    <SWRConfig
      value={{
        dedupingInterval: 5_000,
        focusThrottleInterval: 10_000,
        revalidateOnFocus: false,
      }}
    >
      <ThemeProvider>
        <ToastProvider>
          <PipelineProvider>
            <AppShell>
              <Sidebar user={user} />
              <AppCanvas>
                <TopNav userImage={user.image} />
                <main style={{ flex: 1 }}>{children}</main>
              </AppCanvas>
            </AppShell>
          </PipelineProvider>
        </ToastProvider>
      </ThemeProvider>
    </SWRConfig>
  );
}
