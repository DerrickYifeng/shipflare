export interface DiscoveryJobData {
  userId: string;
  productId: string;
  sources: string[];
  platform: string;
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
  /** When true, perform incremental diff instead of full scan */
  isDailyDiff?: boolean;
}

export interface MonitorJobData {
  userId: string;
  productId: string;
  platform: string;
}

export interface ContentCalendarJobData {
  userId: string;
  productId: string;
  platform: string;
  processUpcoming?: boolean; // When true, process items scheduled within next 48h, not just overdue
}

export interface EngagementJobData {
  userId: string;
  contentId: string;
  contentText: string;
  productId: string;
  platform: string;
}

export interface MetricsJobData {
  userId: string;
  platform: string;
}

export interface AnalyticsJobData {
  userId: string;
  platform: string;
}

export interface TodoSeedJobData {
  userId: string;
}

export interface CalibrationJobData {
  userId: string;
  productId: string;
  /** Max calibration rounds (default: 10). Use 3 for mini re-calibration. */
  maxRounds?: number;
}

// Backward-compat aliases (will be removed after full migration)
export type XMonitorJobData = MonitorJobData;
export type XContentCalendarJobData = ContentCalendarJobData;
export type XEngagementJobData = EngagementJobData;
export type XMetricsJobData = MetricsJobData;
export type XAnalyticsJobData = AnalyticsJobData;

export type JobData =
  | DiscoveryJobData
  | ContentJobData
  | ReviewJobData
  | PostingJobData
  | HealthScoreJobData
  | DreamJobData
  | CodeScanJobData
  | MonitorJobData
  | ContentCalendarJobData
  | EngagementJobData
  | MetricsJobData
  | AnalyticsJobData
  | TodoSeedJobData
  | CalibrationJobData;
