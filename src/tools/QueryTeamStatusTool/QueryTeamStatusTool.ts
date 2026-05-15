// query_team_status — list team_members for the caller's team plus each
// member's current in-flight agent run (if any).
//
// Called by: coordinator — lets the orchestrator check "who is doing
// what" before deciding whether to spawn more parallel work.
//
// `currentTask` is derived from the most recent `agent_runs` row for the
// member that is still in flight (queued / running / resuming / sleeping).
// A member with no in-flight run reports status + lastActiveAt but no
// currentTask.

import { z } from 'zod';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { buildTool } from '@/core/tool-system';
import type { ToolDefinition } from '@/core/types';
import { agentRuns, teamMembers } from '@/lib/db/schema';
import { readTeamScopedDeps } from '@/tools/context-helpers';

export const QUERY_TEAM_STATUS_TOOL_NAME = 'query_team_status';

export interface TeamMemberStatusRow {
  memberId: string;
  agent_type: string;
  display_name: string;
  status: string;
  last_active_at: string | null;
  currentTask?: {
    description: string;
    startedAt: string;
  };
}

const ACTIVE_AGENT_RUN_STATUSES = [
  'queued',
  'running',
  'resuming',
  'sleeping',
] as const;

export const queryTeamStatusTool: ToolDefinition<
  Record<string, never>,
  TeamMemberStatusRow[]
> = buildTool({
  name: QUERY_TEAM_STATUS_TOOL_NAME,
  description:
    'List team members with their live status + last-active timestamp. ' +
    'Includes the member\'s current running task (agent_def_name + spawnedAt) ' +
    'when one exists. Use this to decide whether to parallelize or wait.',
  inputSchema: z.object({}).strict(),
  isConcurrencySafe: true,
  isReadOnly: true,
  async execute(_input, ctx): Promise<TeamMemberStatusRow[]> {
    const { db, teamId } = readTeamScopedDeps(ctx);

    const members = await db
      .select({
        id: teamMembers.id,
        agentType: teamMembers.agentType,
        displayName: teamMembers.displayName,
        status: teamMembers.status,
        lastActiveAt: teamMembers.lastActiveAt,
      })
      .from(teamMembers)
      .where(eq(teamMembers.teamId, teamId))
      .limit(50);

    const result: TeamMemberStatusRow[] = [];
    for (const m of members) {
      // Latest in-flight agent_run for this member, if any. `agent_runs`
      // is the SSOT for task lifecycle — `team_tasks` no longer exists.
      // The `agent_def_name` describes what the teammate is doing (the
      // AGENT.md name), which is what the coordinator wants to read.
      const running = await db
        .select({
          agentDefName: agentRuns.agentDefName,
          spawnedAt: agentRuns.spawnedAt,
        })
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.memberId, m.id),
            inArray(agentRuns.status, [...ACTIVE_AGENT_RUN_STATUSES]),
          ),
        )
        .orderBy(desc(agentRuns.spawnedAt))
        .limit(1);

      const row: TeamMemberStatusRow = {
        memberId: m.id,
        agent_type: m.agentType,
        display_name: m.displayName,
        status: m.status,
        last_active_at:
          m.lastActiveAt instanceof Date
            ? m.lastActiveAt.toISOString()
            : m.lastActiveAt
              ? String(m.lastActiveAt)
              : null,
      };
      if (running.length > 0 && running[0].spawnedAt) {
        row.currentTask = {
          description: running[0].agentDefName,
          startedAt:
            running[0].spawnedAt instanceof Date
              ? running[0].spawnedAt.toISOString()
              : String(running[0].spawnedAt),
        };
      }
      result.push(row);
    }

    return result;
  },
});
