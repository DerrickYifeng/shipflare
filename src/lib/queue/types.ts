export interface DiscoveryJobData {
  userId: string;
  productId: string;
  sources: string[];
  platform: 'reddit' | 'x';
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

export interface CodeScanJobData {
  userId: string;
  repoFullName: string;
  repoUrl: string;
  githubToken: string;
}

export type JobData =
  | DiscoveryJobData
  | ContentJobData
  | ReviewJobData
  | PostingJobData
  | HealthScoreJobData
  | DreamJobData
  | CodeScanJobData;
