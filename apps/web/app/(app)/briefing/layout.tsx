/**
 * /briefing layout — wraps every Briefing tab (today / history / plan)
 * with the tab nav. Mirrors Railway's BriefingShell + TabNav structure
 * minus the server-fetched summary header (CF derives counts client-side
 * via useCmoStub in each tab).
 */

import type { ReactNode } from "react";
import { TabNav } from "./_components/tab-nav";

export default function BriefingLayout({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <>
      <TabNav />
      {children}
    </>
  );
}
