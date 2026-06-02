import type { SessionIntent } from "./types.ts";

export function getAgentId(input: { id?: string; agent?: string }): string | undefined {
	return input.id ?? input.agent;
}

export function getMissingSessionError(params: any): string | undefined {
	if (Array.isArray(params.chain) && params.chain.length > 0) {
		const missingIndex = params.chain.findIndex((step: any) => !step.session);
		if (missingIndex >= 0) return `Missing required session intent for chain step ${missingIndex + 1}; set session to "new" or "resume".`;
	}
	if (Array.isArray(params.tasks) && params.tasks.length > 0) {
		const missingIndex = params.tasks.findIndex((task: any) => !task.session);
		if (missingIndex >= 0) return `Missing required session intent for parallel task ${missingIndex + 1}; set session to "new" or "resume".`;
	}
	if (getAgentId(params) && params.task && !params.session) {
		return 'Missing required session intent for single subagent call; set session to "new" or "resume".';
	}
	return undefined;
}

export type RequestedDelegation = { id: string | undefined; session?: SessionIntent; task: string; step?: number };
