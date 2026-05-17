import { CMO } from './cmo/CMO';
// import { HoG } from './head-of-growth/HeadOfGrowth';      // added in Task 4.5
// import { SMM } from './social-media-manager/SocialMediaMgr';  // added in Task 4.4

export type EmployeeId = 'cmo' | 'hog' | 'smm';

export interface EmployeeMeta {
	// TODO(Phase 5): tighten to `typeof AIChatAgent` once CMO is migrated.
	// Currently loose because CMO still extends McpAgent.
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	class: any;
	envBinding: string;
	displayName: string;
	description: string;
	systemPromptPath: string;
}

export const EMPLOYEE_REGISTRY: Partial<Record<EmployeeId, EmployeeMeta>> = {
	cmo: {
		class: CMO,
		envBinding: 'CMO',
		displayName: 'Chief Marketing Officer',
		description: 'Strategic marketing leadership; the orchestrator.',
		// TODO(Task 4.7): replace this workspace-relative string with a
		// runtime-safe form (bundler inline import or DO asset URL);
		// CF Workers have no fs / __dirname so readFileSync won't work.
		systemPromptPath: 'apps/core/src/agents/cmo/SYSTEM.md',
	},
};

export const EMPLOYEE_IDS = Object.keys(EMPLOYEE_REGISTRY) as EmployeeId[];
