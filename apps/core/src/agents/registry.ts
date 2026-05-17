import type { ChatCapableAgentClass } from 'agents/agent-tools';
import { CMO } from './cmo/CMO';
import { HoG } from './head-of-growth/HeadOfGrowth';
import { SMM } from './social-media-manager/SocialMediaMgr';

export type EmployeeId = 'cmo' | 'hog' | 'smm';

/**
 * Each concrete employee subclass (CMO/HoG/SMM) extends `AIChatAgent`,
 * which `agentTool(...)` accepts via the agents-SDK `ChatCapableAgentClass`
 * shape (a constructor returning an `Agent` subtype). Storing the class
 * under that type lets `consult-tool.ts` hand it to `agentTool(...)`
 * without a wide `any`.
 */
export interface EmployeeMeta {
	class: ChatCapableAgentClass;
	envBinding: string;
	displayName: string;
	description: string;
	systemPromptPath: string;
}

export const EMPLOYEE_REGISTRY: Partial<Record<EmployeeId, EmployeeMeta>> = {
	cmo: {
		class: CMO as unknown as ChatCapableAgentClass,
		envBinding: 'CMO',
		displayName: 'Chief Marketing Officer',
		description: 'Strategic marketing leadership; the orchestrator.',
		// TODO(Task 4.7): replace this workspace-relative string with a
		// runtime-safe form (bundler inline import or DO asset URL);
		// CF Workers have no fs / __dirname so readFileSync won't work.
		systemPromptPath: 'apps/core/src/agents/cmo/SYSTEM.md',
	},
	hog: {
		class: HoG as unknown as ChatCapableAgentClass,
		envBinding: 'HOG',
		displayName: 'Head of Growth',
		description: 'Growth strategy, acquisition funnels, retention experiments.',
		// TODO(Task 4.7): replace this workspace-relative string with a
		// runtime-safe form (bundler inline import or DO asset URL);
		// CF Workers have no fs / __dirname so readFileSync won't work.
		systemPromptPath: 'apps/core/src/agents/head-of-growth/SYSTEM.md',
	},
	smm: {
		class: SMM as unknown as ChatCapableAgentClass,
		envBinding: 'SMM',
		displayName: 'Social Media Manager',
		description: 'Channel-specific drafting, voice, posting cadence.',
		// TODO(Task 4.7): replace this workspace-relative string with a
		// runtime-safe form (bundler inline import or DO asset URL);
		// CF Workers have no fs / __dirname so readFileSync won't work.
		systemPromptPath: 'apps/core/src/agents/social-media-manager/SYSTEM.md',
	},
};

export const EMPLOYEE_IDS = Object.keys(EMPLOYEE_REGISTRY) as EmployeeId[];
