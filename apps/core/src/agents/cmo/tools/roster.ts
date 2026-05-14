import { z } from "zod";
import { ROLE_REGISTRY, isValidRole } from "@shipflare/shared";
import type { CMO } from "../CMO";

/**
 * Roster tools — manage which employees this founder has hired.
 *
 * Per spec D12 (static role registry + dynamic hire): the workspace has a
 * fixed set of possible roles defined in `@shipflare/shared`'s
 * `ROLE_REGISTRY`. Each user picks which to hire. Hire/fire is reversible —
 * "fire" preserves history and the employee's DO + SQLite stay intact in
 * case of re-hire.
 *
 * CMO is implicit (always present); attempting to hire/fire it is rejected
 * at the tool layer so the founder can't accidentally evict their own
 * orchestrator.
 */
export function registerRosterTools(agent: CMO): void {
  agent.server.registerTool(
    "hireEmployee",
    {
      description:
        "Hire an employee role for this team. Idempotent — re-hire " +
        "of a fired role just flips status back to 'active'.",
      inputSchema: {
        role: z.string(),
        hireConfig: z.record(z.string(), z.unknown()).optional(),
      },
    },
    async ({ role, hireConfig }) => {
      if (role === "cmo") {
        throw new Error("CMO is implicit; cannot hire");
      }
      if (!isValidRole(role)) {
        throw new Error(
          `Unknown role: ${role}. Valid: ${Object.keys(ROLE_REGISTRY).join(", ")}`,
        );
      }
      const now = Date.now();
      agent.sqlStorage.exec(
        `INSERT INTO roster (role, hired_at, status, hire_config_json)
         VALUES (?, ?, 'active', ?)
         ON CONFLICT(role) DO UPDATE SET
           status = 'active',
           hire_config_json = excluded.hire_config_json`,
        role,
        now,
        hireConfig ? JSON.stringify(hireConfig) : null,
      );
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ role, status: "active" }),
          },
        ],
      };
    },
  );

  agent.server.registerTool(
    "fireEmployee",
    {
      description:
        "Set employee status to 'fired'. Preserves SQLite + history; " +
        "re-hireable via hireEmployee.",
      inputSchema: {
        role: z.string(),
      },
    },
    async ({ role }) => {
      if (role === "cmo") {
        throw new Error("CMO is implicit; cannot fire");
      }
      const result = agent.sqlStorage.exec(
        "UPDATE roster SET status = 'fired' WHERE role = ?",
        role,
      );
      if (result.rowsWritten === 0) {
        throw new Error(`Role not in roster: ${role}`);
      }
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ role, status: "fired" }),
          },
        ],
      };
    },
  );

  agent.server.registerTool(
    "queryRoster",
    {
      description:
        "Return the full team roster (all statuses, ordered by hire date).",
      inputSchema: {},
    },
    async () => {
      const rows = agent.sqlStorage
        .exec<{
          role: string;
          hired_at: number;
          status: string;
          hire_config_json: string | null;
        }>(
          `SELECT role, hired_at, status, hire_config_json
           FROM roster
           ORDER BY hired_at ASC`,
        )
        .toArray();
      return {
        content: [{ type: "text" as const, text: JSON.stringify(rows) }],
      };
    },
  );
}
