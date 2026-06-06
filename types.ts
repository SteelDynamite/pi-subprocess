import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import type { AgentScope, AgentOrigin } from "./agents.ts";

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

export interface SubprocessSettings {
	reuseEnabled: boolean;
	contextThreshold: number;
}

export type SubagentSettings = SubprocessSettings;

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

export interface PersistedSubprocessState {
	settings: SubprocessSettings;
	sessions: TrackedSession[];
}

export type PersistedSubagentState = PersistedSubprocessState;

export interface WrongSessionIntentError {
	agentId: string;
	requested: SessionIntent;
	required: SessionIntent;
	recommendedRetry: string;
}

export interface SingleResult {
	kind?: "subagent" | "command";
	agent: string;
	agentOrigin: AgentOrigin | "unknown";
	sessionIntent?: SessionIntent;
	wrongSessionIntent?: WrongSessionIntentError;
	task: string;
	exitCode: number;
	messages: Message[];
	stdout?: string;
	stderr: string;
	stdoutBytes?: number;
	stderrBytes?: number;
	stdoutTruncated?: boolean;
	stderrTruncated?: boolean;
	usage: UsageStats;
	model?: string;
	contextWindow?: number;
	warning?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
	cwd?: string;
	durationMs?: number;
	command?: string;
	timeoutMs?: number;
	timedOut?: boolean;
	nextSessionIntent?: SessionIntent;
	nestedSubprocesses?: NestedSubprocessCall[];
}

export interface NestedSubprocessCall {
	toolCallId: string;
	toolName: "subprocess" | "subagent";
	status: "running" | "completed" | "failed";
	details?: SubprocessDetails;
	error?: string;
	truncated?: boolean;
}

export interface SubprocessDetails {
	mode: "single" | "parallel" | "chain";
	agentScope: AgentScope;
	includeLocationalAgents: boolean;
	projectAgentsDir: string | null;
	locationalAgents: string[];
	results: SingleResult[];
}

export type SubagentDetails = SubprocessDetails;

export type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

export type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;
export type OnCommandUpdateCallback = (result: SingleResult) => void;
