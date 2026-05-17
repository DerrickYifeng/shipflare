export const MAX_AGENT_DEPTH = 3;

export class AgentDepthExceededError extends Error {
	constructor(public chain: string[]) {
		super(`Agent dispatch depth exceeded (${chain.join(' → ')})`);
		this.name = 'AgentDepthExceededError';
	}
}

export class AgentCycleError extends Error {
	constructor(public chain: string[], public target: string) {
		super(`Agent dispatch cycle (${chain.join(' → ')} → ${target})`);
		this.name = 'AgentCycleError';
	}
}

interface ChainContext { props: { __agentChain?: string[] } & Record<string, unknown> }

export const safeAgentChain = {
	check(ctx: ChainContext, targetClassName: string): void {
		const chain: string[] = ctx.props.__agentChain ?? [];
		if (chain.length >= MAX_AGENT_DEPTH) throw new AgentDepthExceededError(chain);
		if (chain.includes(targetClassName)) throw new AgentCycleError(chain, targetClassName);
		ctx.props.__agentChain = [...chain, targetClassName];
	},
};
