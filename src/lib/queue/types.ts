export interface DiscoveryJobData {
  userId: string;
  productId: string;
  subreddits: string[];
}

export interface ContentJobData {
  userId: string;
  threadId: string;
  productId: string;
  draftType?: 'reply' | 'original_post';
  communityIntel?: unknown;
}

export interface ReviewJobData {
  userId: string;
  draftId: string;
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

export interface DreamJobData {
  productId: string;
}

export type JobData =
  | DiscoveryJobData
  | ContentJobData
  | ReviewJobData
  | PostingJobData
  | HealthScoreJobData
  | DreamJobData;
