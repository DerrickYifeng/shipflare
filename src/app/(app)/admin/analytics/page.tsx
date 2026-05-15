import { getFunnel } from './_queries/funnel';
import { getRetention } from './_queries/retention';
import { getDailyActivity } from './_queries/daily';
import { getActiveUsers } from './_queries/users';
import { Funnel } from './_components/funnel';
import { Retention } from './_components/retention';
import { SparkRow } from './_components/spark-row';
import { UserTable } from './_components/user-table';

export const revalidate = 60; // 1-minute ISR

export default async function AdminAnalyticsPage() {
  const [funnel, retention, daily, userRows] = await Promise.all([
    getFunnel(),
    getRetention(),
    getDailyActivity(),
    getActiveUsers(),
  ]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 40 }}>
      <Funnel counts={funnel} />
      <Retention data={retention} />
      <SparkRow daily={daily} />
      <UserTable rows={userRows} />
    </div>
  );
}

export const metadata = {
  title: 'Analytics — ShipFlare admin',
};
