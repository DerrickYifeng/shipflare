// query_team_status — list team_members for the caller's team plus each
// member's current in-flight task (if any).
//
// Called by: coordinator — lets the orchestrator check "who is doing
// what" before deciding whether to spawn more parallel work.
//
// `currentTask` is derived from the most recent `team_tasks` row for the
// member with status='running'. A member with no running task reports
// status + lastActiveAt but no currentTask.

import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';
import { buildTool } from '@/core/tool-system';
import type { ToolDefinition } from '@/core/types';
import { teamMembers, teamTasks } from '@/lib/db/schema';
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

export const queryTeamStatusTool: ToolDefinition<
  Record<string, never>,
  TeamMemberStatusRow[]
> = buildTool({
  name: QUERY_TEAM_STATUS_TOOL_NAME,
  description:
    'List team members with their live status + last-active timestamp. ' +
    'Includes the member\'s current running task (description + startedAt) ' +
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
      // Latest running task for this member, if any. We look at team_tasks
      // rather than team_messages because team_tasks carries the
      // description / startedAt fields we need structurally.
      const running = await db
        .select({
          description: teamTasks.description,
          startedAt: teamTasks.startedAt,
        })
        .from(teamTasks)
        .where(
          and(
            eq(teamTasks.memberId, m.id),
            eq(teamTasks.status, 'running'),
          ),
        )
        .orderBy(desc(teamTasks.startedAt))
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
      if (running.length > 0 && running[0].startedAt) {
        row.currentTask = {
          description: running[0].description,
          startedAt:
            running[0].startedAt instanceof Date
              ? running[0].startedAt.toISOString()
              : String(running[0].startedAt),
        };
      }
      result.push(row);
    }

    return result;
  },
});
