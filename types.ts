import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import type { AgentScope, AgentSource } from "./agents.ts";

export type SessionIntent = "new" | "resume";

export type NextIntentReason = "none" | "under-threshold" | "over-threshold" | "reuse-disabled" | "non-resumable";

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface SubagentSettings {
	reuseEnabled: boolean;
	contextThreshold: number;
}

export interface TrackedSession {
	mainSessionKey: string;
	agentId: string;
	sessionId: string;
	nextIntent: SessionIntent;
	reason: NextIntentReason;
	contextTokens: number;
	contextWindow?: number;
	updatedAt: number;
}

export interface PersistedSubagentState {
	settings: SubagentSettings;
	sessions: TrackedSession[];
}

export interface WrongSessionIntentError {
	agentId: string;
	requested: SessionIntent;
	required: SessionIntent;
	recommendedRetry: string;
}

export interface SingleResult {
	agent: string;
	agentSource: AgentSource | "unknown";
	sessionIntent?: SessionIntent;
	wrongSessionIntent?: WrongSessionIntentError;
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	contextWindow?: number;
	warning?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
	cwd?: string;
	nextSessionIntent?: SessionIntent;
}

export interface SubagentDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	includeSourceAgents: boolean;
	projectAgentsDir: string | null;
	sourceAgents: string[];
	results: SingleResult[];
}

export type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

export type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;
