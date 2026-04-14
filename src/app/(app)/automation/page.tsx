import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { HeaderBar } from '@/components/layout/header-bar';
import { PipelineStatus } from '@/components/automation/pipeline-status';
import { AgentsWarRoom } from './agents-war-room';

export default async function AgentsPage() {
  const session = await auth();
  if (!session?.user?.id) redirect('/');

  return (
    <>
      <HeaderBar title="Automation" />
      <div className="px-6 pt-6">
        <PipelineStatus />
      </div>
      <AgentsWarRoom />
    </>
  );
}
