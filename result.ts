import type { Message } from "@earendil-works/pi-ai";
import { PER_TASK_OUTPUT_CAP } from "./constants.ts";
import { getAgentId } from "./params.ts";
import type { DisplayItem, SingleResult } from "./types.ts";

export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

export function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	if (model) parts.push(model);
	return parts.join(" ");
}

export function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (let j = msg.content.length - 1; j >= 0; j--) {
				const part = msg.content[j];
				if (part.type === "text" && part.text.trim() !== "") return part.text;
			}
		}
	}
	return "";
}

export function isFailedResult(result: SingleResult): boolean {
	return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

export function getResultOutput(result: SingleResult): string {
	const warning = result.warning ? `Warning: ${result.warning}\n\n` : "";
	const nextIntent = result.nextSessionIntent
		? `\n\nNext call to this subagent should use session: "${result.nextSessionIntent}"`
		: "";
	if (isFailedResult(result)) {
		return warning + (result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)");
	}
	return warning + (getFinalOutput(result.messages) || "(no output)") + nextIntent;
}

export function truncateParallelOutput(output: string): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= PER_TASK_OUTPUT_CAP) return output;

	let truncated = output.slice(0, PER_TASK_OUTPUT_CAP);
	while (Buffer.byteLength(truncated, "utf8") > PER_TASK_OUTPUT_CAP) {
		truncated = truncated.slice(0, -1);
	}
	return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted. Full output preserved in tool details.]`;
}

export function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

export function getNestedSubagentIds(messages: Message[]): string[] {
	return getDisplayItems(messages)
		.filter((item): item is Extract<DisplayItem, { type: "toolCall" }> => item.type === "toolCall" && item.name === "subagent")
		.flatMap((item) => {
			const args = item.args as any;
			if (args.chain && Array.isArray(args.chain)) return args.chain.map((step: any) => getAgentId(step)).filter(Boolean);
			if (args.tasks && Array.isArray(args.tasks)) return args.tasks.map((task: any) => getAgentId(task)).filter(Boolean);
			const id = getAgentId(args);
			return id ? [id] : [];
		});
}

export function makeErrorResult(
	agentId: string,
	task: string,
	message: string,
	step?: number,
	sessionIntent?: SingleResult["sessionIntent"],
	extra: Partial<Pick<SingleResult, "agentOrigin" | "errorMessage" | "wrongSessionIntent">> = {},
): SingleResult {
	return {
		agent: agentId,
		agentOrigin: extra.agentOrigin ?? "unknown",
		sessionIntent,
		wrongSessionIntent: extra.wrongSessionIntent,
		task,
		exitCode: 1,
		messages: [],
		stderr: message,
		errorMessage: extra.errorMessage,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		step,
	};
}
