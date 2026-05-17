import type { EmployeeId } from '../registry';

/**
 * STUB — replaced in Task 4.7 of the CF-native chat migration.
 *
 * Returns a static placeholder so AIChatAgent subclasses compile during
 * Phase 4. Task 4.7 swaps this for a real loader that reads the
 * appropriate `SYSTEM.md` + `_SYSTEM_PREAMBLE.md` from the bundled
 * assets and composes the final system prompt.
 */
export async function loadSystemPrompt(_id: EmployeeId): Promise<string> {
	return 'You are a ShipFlare agent.';
}
