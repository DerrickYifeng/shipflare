export interface DiscoveryJobData {
  userId: string;
  productId: string;
  subreddits: string[];
}

export interface ContentJobData {
  userId: string;
  threadId: string;
  productId: string;
}

export interface PostingJobData {
  userId: string;
  draftId: string;
  channelId: string;
}

export interface HealthScoreJobData {
  userId: string;
}

export type JobData =
  | DiscoveryJobData
  | ContentJobData
  | PostingJobData
  | HealthScoreJobData;
