import { MAX_NESTED_SUBPROCESSES_PER_RESULT, NESTED_SUBPROCESS_DETAIL_CAP } from "./constants.ts";
import type { NestedSubprocessCall, SingleResult, SubprocessDetails, UsageStats } from "./types.ts";

const NESTED_TOOL_NAMES = new Set(["subprocess", "subagent"]);

function isNestedToolName(name: unknown): name is NestedSubprocessCall["toolName"] {
	return typeof name === "string" && NESTED_TOOL_NAMES.has(name);
}

export function isSubprocessDetails(value: unknown): value is SubprocessDetails {
	const details = value as Partial<SubprocessDetails> | undefined;
	return Boolean(
		details &&
		(details.mode === "single" || details.mode === "parallel" || details.mode === "chain") &&
		Array.isArray(details.results),
	);
}

function utf8Bytes(value: unknown): number {
	try {
		return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
	} catch {
		return Number.POSITIVE_INFINITY;
	}
}

function truncateUtf8(text: string | undefined, maxBytes: number): string | undefined {
	if (text === undefined || Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	let truncated = text.slice(0, maxBytes);
	while (Buffer.byteLength(truncated, "utf8") > maxBytes) truncated = truncated.slice(0, -1);
	return `${truncated}\n[truncated]`;
}

function emptyUsage(usage: UsageStats | undefined): UsageStats {
	return usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

function makeCappedResult(result: SingleResult): SingleResult {
	return {
		kind: result.kind,
		agent: result.agent,
		agentOrigin: result.agentOrigin,
		sessionIntent: result.sessionIntent,
		wrongSessionIntent: result.wrongSessionIntent,
		task: truncateUtf8(result.task, 1024) ?? "",
		exitCode: result.exitCode,
		messages: [],
		stdout: truncateUtf8(result.stdout, 2048),
		stderr: truncateUtf8(result.stderr, 2048) ?? "",
		stdoutBytes: result.stdoutBytes,
		stderrBytes: result.stderrBytes,
		stdoutTruncated: result.stdoutTruncated,
		stderrTruncated: result.stderrTruncated,
		usage: emptyUsage(result.usage),
		model: result.model,
		contextWindow: result.contextWindow,
		warning: truncateUtf8(result.warning, 512),
		stopReason: result.stopReason,
		errorMessage: truncateUtf8(result.errorMessage, 512),
		step: result.step,
		cwd: result.cwd,
		durationMs: result.durationMs,
		command: truncateUtf8(result.command, 1024),
		timeoutMs: result.timeoutMs,
		timedOut: result.timedOut,
		nextSessionIntent: result.nextSessionIntent,
		nestedSubprocesses: result.nestedSubprocesses?.slice(0, 2).map((nested) => ({
			toolCallId: nested.toolCallId,
			toolName: nested.toolName,
			status: nested.status,
			error: truncateUtf8(nested.error, 512),
			truncated: true,
		})),
	};
}

function capSubprocessDetails(details: SubprocessDetails): { details: SubprocessDetails; truncated: boolean } {
	if (utf8Bytes(details) <= NESTED_SUBPROCESS_DETAIL_CAP) return { details, truncated: false };

	const capped: SubprocessDetails = {
		mode: details.mode,
		agentScope: details.agentScope,
		includeLocationalAgents: details.includeLocationalAgents,
		projectAgentsDir: details.projectAgentsDir,
		locationalAgents: details.locationalAgents.slice(0, 8),
		results: details.results.slice(0, 4).map(makeCappedResult),
	};
	return { details: capped, truncated: true };
}

function resultText(result: any): string | undefined {
	const text = result?.content
		?.filter((part: any) => part?.type === "text" && typeof part.text === "string")
		.map((part: any) => part.text)
		.join("\n")
		.trim();
	return text || undefined;
}

function upsertNestedCall(result: SingleResult, toolCallId: string, toolName: NestedSubprocessCall["toolName"]): NestedSubprocessCall | undefined {
	result.nestedSubprocesses ??= [];
	let nested = result.nestedSubprocesses.find((call) => call.toolCallId === toolCallId);
	if (nested) {
		nested.toolName = toolName;
		return nested;
	}
	if (result.nestedSubprocesses.length >= MAX_NESTED_SUBPROCESSES_PER_RESULT) return undefined;
	nested = { toolCallId, toolName, status: "running" };
	result.nestedSubprocesses.push(nested);
	return nested;
}

function attachDetails(nested: NestedSubprocessCall, details: unknown): void {
	if (!isSubprocessDetails(details)) return;
	const capped = capSubprocessDetails(details);
	nested.details = capped.details;
	nested.truncated = nested.truncated || capped.truncated;
}

export function applyNestedSubprocessEvent(result: SingleResult, event: any): boolean {
	if (!event || !isNestedToolName(event.toolName) || typeof event.toolCallId !== "string") return false;
	if (event.type !== "tool_execution_start" && event.type !== "tool_execution_update" && event.type !== "tool_execution_end") return false;

	const nested = upsertNestedCall(result, event.toolCallId, event.toolName);
	if (!nested) return false;

	if (event.type === "tool_execution_start") {
		nested.status = "running";
		nested.error = undefined;
		return true;
	}

	if (event.type === "tool_execution_update") {
		attachDetails(nested, event.partialResult?.details);
		return true;
	}

	attachDetails(nested, event.result?.details);
	nested.status = event.isError ? "failed" : "completed";
	nested.error = event.isError ? resultText(event.result) ?? "Nested subprocess failed" : undefined;
	return true;
}
