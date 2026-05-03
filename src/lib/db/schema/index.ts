export { users, accounts, sessions, verificationTokens, userPreferences } from './users';
export {
  allowedEmails,
  type AllowedEmail,
  type NewAllowedEmail,
} from './allowed-emails';
export { products } from './products';
export { channels, threads } from './channels';
export {
  drafts,
  posts,
  healthScores,
  activityEvents,
  draftStatusEnum,
  postStatusEnum,
} from './drafts';
export { agentMemories, agentMemoryLogs } from './memories';
export { codeSnapshots } from './code-snapshots';
export {
  xTargetAccounts,
  xMonitoredTweets,
  xTweetMetrics,
  xFollowerSnapshots,
  xAnalyticsSummary,
  xMonitoredTweetStatusEnum,
  // Platform-generic aliases
  analyticsSummary,
  targetAccounts,
  monitoredContent,
} from './x-growth';
// Note: xContentCalendarItemStateEnum is intentionally NOT re-exported.
// It still exists in x-growth.ts as an internal dependency of
// threads.state (channels.ts imports it directly). Renaming the enum
// requires an ALTER TYPE migration with live-data risk — deferred
// until the audit's "option b" rename is green-lit.
export {
  pipelineEvents,
  threadFeedback,
  type PipelineEvent,
  type NewPipelineEvent,
  type ThreadFeedback,
  type NewThreadFeedback,
} from './pipeline-events';
export {
  strategicPaths,
  launchPhaseEnum,
} from './strategic-paths';
export {
  plans,
  planTriggerEnum,
} from './plans';
export {
  planItems,
  planItemKindEnum,
  planItemStateEnum,
  planItemUserActionEnum,
} from './plan-items';
export {
  teams,
  teamMembers,
  teamConversations,
  teamMessages,
  teamTasks,
  agentRuns,
  type Team,
  type NewTeam,
  type TeamMember,
  type NewTeamMember,
  type TeamConversation,
  type NewTeamConversation,
  type TeamMessage,
  type NewTeamMessage,
  type TeamTask,
  type NewTeamTask,
  type AgentRun,
  type NewAgentRun,
} from './team';
