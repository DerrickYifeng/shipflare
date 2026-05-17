/**
 * Client-side mirror of `apps/core/src/agents/registry.ts`'s EMPLOYEE_REGISTRY.
 *
 * The core registry holds the runtime DO classes which can't be bundled into
 * Next.js. This file mirrors just the display metadata (displayName +
 * description) the chat UI needs to label nested-agent-run cards.
 *
 * **MUST stay in sync** with core's registry. CLAUDE.md's New Employee
 * Checklist lists this file as a required mirror site (Task 8.5).
 */

export interface EmployeeMetaClient {
	displayName: string;
	description: string;
}

export const EMPLOYEE_REGISTRY: Record<string, EmployeeMetaClient> = {
	cmo: {
		displayName: "Chief Marketing Officer",
		description: "Strategic marketing leadership; the orchestrator.",
	},
	hog: {
		displayName: "Head of Growth",
		description: "Growth strategy, acquisition funnels, retention experiments.",
	},
	smm: {
		displayName: "Social Media Manager",
		description: "Channel-specific drafting, voice, posting cadence.",
	},
};
