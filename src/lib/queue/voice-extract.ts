import { Queue } from 'bullmq';
import { getBullMQConnection } from '@/lib/redis';

const connection = { connection: getBullMQConnection() };

const DEFAULT_JOB_OPTIONS = {
  removeOnComplete: { count: 500, age: 24 * 3600 },
  removeOnFail: { count: 2000, age: 7 * 24 * 3600 },
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 2000 },
};

export interface VoiceExtractJobData {
  schemaVersion: 1;
  userId: string;
  channel: 'x';
  triggerReason: 'onboarding' | 'manual' | 'monthly_cron';
  traceId?: string;
}

export const voiceExtractQueue = new Queue<VoiceExtractJobData>(
  'voice-extract',
  {
    ...connection,
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
  },
);

export async function enqueueVoiceExtract(
  data: VoiceExtractJobData,
): Promise<void> {
  const jobId = `voice-extract-${data.userId}-${data.channel}`;
  await voiceExtractQueue.add('extract', data, { jobId });
}
