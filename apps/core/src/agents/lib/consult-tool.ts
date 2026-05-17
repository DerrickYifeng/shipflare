import { tool } from 'ai';
import { z } from 'zod';
import type { EmployeeId } from '../registry';

/**
 * STUB — replaced in Task 4.6 of the CF-native chat migration.
 *
 * Returns a no-op `consult` tool so the SMM / HoG class files compile
 * during Phase 4. Task 4.6 swaps this for the real implementation that
 * dispatches to the target employee DO via `agentTool(Cls)`.
 */
export function makeConsultTool(_selfId: EmployeeId) {
	return tool({
		description: 'STUB — Task 4.6 replaces this with the real consult dispatcher.',
		inputSchema: z.object({}),
		execute: async () => ({ answer: 'stub' }),
	});
}
