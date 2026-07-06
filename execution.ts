import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type ExtensionAPI, type ExtensionContext, withFileMutationQueue } from "./pi-compat.ts";
import type { Message } from "@earendil-works/pi-ai";
import type { AgentConfig } from "./agents.ts";
import { getAgentInstructionsFileName, isPathInside, resolveLocationalAgentId, scanLocationalAgents } from "./agents.ts";
import {
	ADVERTISE_LOCATIONAL_AGENTS_ENV,
	DEFAULT_KNOWN_TOOLS,
	LOCATIONAL_PREFERRED_MODELS_ENV,
	MAX_SUBPROCESS_DEPTH,
	ORCHESTRATED_CHILD_ENV,
	SUBPROCESS_CHILD_ENV,
	SUBPROCESS_DEPTH_ENV,
} from "./constants.ts";
import { createSubprocessLifecycle, getSubprocessLifecycleSnapshot, markSubprocessActivity, markSubprocessClosed, markSubprocessTerminating, recordSubprocessError } from "./lifecycle.ts";
import { applyNestedSubprocessEvent } from "./nested.ts";
import { getFinalOutput, isFailedResult, makeErrorResult } from "./result.ts";
import { formatWrongIntentReason, getRequiredSessionIntent, getWrongIntentRetry, persistSubprocessState, subprocessSettings, updateTrackedSession } from "./state.ts";
import { getLocationalLoopError, makeChildLocationalEnv, notifyLocationalBoundaryDiscovered } from "./locational-guard.ts";
import type { OnUpdateCallback, SessionIntent, SingleResult, SubprocessDetails } from "./types.ts";

let knownToolNames = new Set(DEFAULT_KNOWN_TOOLS);

export function setKnownToolNames(names: Iterable<string>) {
	knownToolNames = new Set(names);
}

export function resolveAgent(defaultCwd: string, agents: AgentConfig[], id: string): AgentConfig | undefined {
	const locationalAgent = resolveLocationalAgentId(defaultCwd, id);
	if (locationalAgent) return locationalAgent;
	return agents.find((a) => a.kind === "behavioral" && a.id === id);
}

function resolveOptionalCwd(defaultCwd: string, cwd: string | undefined): string | undefined {
	if (!cwd) return undefined;
	return path.resolve(defaultCwd, cwd);
}

function formatModelRef(model: ExtensionContext["model"]): string | undefined {
	return model ? `${model.provider}/${model.id}` : undefined;
}

type ResolvedAgentModel = {
	model?: string;
	contextWindow?: number;
	warning?: string;
	source: "agent" | "preferred" | "caller";
	fallbackModel?: string;
	fallbackContextWindow?: number;
};

function parseModelCandidates(value: string | undefined): string[] {
	if (value === undefined) return [];
	return value
		.split(",")
		.map((m) => m.trim())
		.filter(Boolean);
}

function getLocationalPreferredModelCandidates(): string[] {
	return parseModelCandidates(process.env[LOCATIONAL_PREFERRED_MODELS_ENV]);
}

function resolveAvailableModel(
	candidates: string[],
	ctx: ExtensionContext,
): { model?: string; contextWindow?: number } {
	const available = ctx.modelRegistry.getAvailable();
	for (const candidate of candidates) {
		const match = available.find((model) => `${model.provider}/${model.id}` === candidate || model.id === candidate);
		if (match) return { model: `${match.provider}/${match.id}`, contextWindow: (match as any).contextWindow };
	}
	return {};
}

export function resolveAgentModel(agent: AgentConfig, ctx: ExtensionContext): ResolvedAgentModel {
	const callerModel = formatModelRef(ctx.model);
	const callerContextWindow = (ctx.model as any)?.contextWindow;
	const explicitCandidates = parseModelCandidates(agent.model);

	if (explicitCandidates.length > 0) {
		const resolved = resolveAvailableModel(explicitCandidates, ctx);
		if (resolved.model) return { ...resolved, source: "agent", fallbackModel: callerModel, fallbackContextWindow: callerContextWindow };
		return {
			model: callerModel,
			contextWindow: callerContextWindow,
			source: "caller",
			warning: `No configured model from "${agent.model}" for ${agent.id}; using caller model${callerModel ? ` ${callerModel}` : ""}.`,
		};
	}

	if (agent.kind === "locational") {
		const preferred = resolveAvailableModel(getLocationalPreferredModelCandidates(), ctx);
		if (preferred.model) return { ...preferred, source: "preferred", fallbackModel: callerModel, fallbackContextWindow: callerContextWindow };
	}

	return { model: callerModel, contextWindow: callerContextWindow, source: "caller" };
}

export function validateAgentTools(agent: AgentConfig): string | undefined {
	if (!agent.tools) return undefined;
	const unknown = agent.tools.filter((tool) => !knownToolNames.has(tool));
	if (unknown.length === 0) return undefined;
	return `${agent.filePath}: unknown tool(s): ${unknown.join(", ")}. Explicit tools must match available tool names exactly.`;
}

export function makeSubprocessChildEnv(
	agent: AgentConfig,
	currentDepth: number,
	includeLocationalAgentsInBehavioralChild: boolean,
): Record<string, string> {
	const advertiseLocationalAgents = agent.kind === "behavioral" ? (includeLocationalAgentsInBehavioralChild ? "1" : "0") : "1";
	const depth = String(currentDepth + 1);
	return {
		[SUBPROCESS_DEPTH_ENV]: depth,
		[SUBPROCESS_CHILD_ENV]: "1",
		[ORCHESTRATED_CHILD_ENV]: "1",
		[ADVERTISE_LOCATIONAL_AGENTS_ENV]: advertiseLocationalAgents,
		...makeChildLocationalEnv(agent),
	};
}

export function processChildJsonEvent(event: any, currentResult: SingleResult, emitUpdate: () => void): void {
	if (applyNestedSubprocessEvent(currentResult, event)) emitUpdate();

	if (event.type === "message_end" && event.message) {
		const msg = event.message as Message;
		currentResult.messages.push(msg);

		if (msg.role === "assistant") {
			currentResult.usage.turns++;
			const usage = msg.usage;
			if (usage) {
				currentResult.usage.input += usage.input || 0;
				currentResult.usage.output += usage.output || 0;
				currentResult.usage.cacheRead += usage.cacheRead || 0;
				currentResult.usage.cacheWrite += usage.cacheWrite || 0;
				currentResult.usage.cost += usage.cost?.total || 0;
				currentResult.usage.contextTokens = usage.totalTokens || 0;
			}
			if (!currentResult.model && msg.model) currentResult.model = msg.model;
			if (msg.stopReason) currentResult.stopReason = msg.stopReason;
			if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
		}
		emitUpdate();
	}

	if (event.type === "tool_result_end" && event.message) {
		currentResult.messages.push(event.message as Message);
		emitUpdate();
	}
}

function appendWarning(result: SingleResult, warning: string) {
	result.warning = result.warning ? `${result.warning}\n${warning}` : warning;
}

function hasMeaningfulTaskWork(result: SingleResult): boolean {
	return result.messages.some((message) => {
		const msg = message as any;
		if (msg.role === "toolResult") return true;
		if (msg.role !== "assistant") return false;
		return msg.content?.some((part: any) => {
			if (part.type === "text") return part.text.trim() !== "";
			return part.type === "toolCall";
		});
	});
}

export function shouldRetryPreferredModelFailure(result: SingleResult): boolean {
	if (!isFailedResult(result)) return false;
	if (hasMeaningfulTaskWork(result)) return false;
	const text = [result.errorMessage, result.stderr, getFinalOutput(result.messages), result.stopReason]
		.filter(Boolean)
		.join("\n")
		.toLowerCase();
	if (!text.trim()) return true;
	return /model|provider|rate|429|quota|auth|api key|unauthori[sz]ed|forbidden|permission|billing|overloaded|unavailable|not found|not configured|pre[- ]?start|failed to load|invalid[_ -]?request/.test(text);
}

function shouldRetryWithCallerModel(agent: AgentConfig, resolvedModel: ResolvedAgentModel): boolean {
	return agent.kind === "locational" && Boolean(resolvedModel.fallbackModel) && resolvedModel.fallbackModel !== resolvedModel.model;
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subprocess-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

export async function runDelegation(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	defaultCwd: string,
	agents: AgentConfig[],
	agentId: string,
	session: SessionIntent,
	task: string,
	cwd: string | undefined,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => SubprocessDetails,
	includeLocationalAgentsInBehavioralChild: boolean,
): Promise<SingleResult> {
	const agent = resolveAgent(defaultCwd, agents, agentId);

	if (!agent) {
		const available = agents.map((a) => `"${a.id}"`).join(", ") || "none";
		return makeErrorResult(agentId, task, `Unknown subprocess agent id: "${agentId}". Available agents: ${available}.`, step, session);
	}
	const agentConfig = agent;

	const currentDepth = Number(process.env[SUBPROCESS_DEPTH_ENV] ?? "0");
	if (currentDepth >= MAX_SUBPROCESS_DEPTH) {
		return makeErrorResult(agentConfig.id, task, `Subprocess recursion limit reached (max depth ${MAX_SUBPROCESS_DEPTH}).`, step, session);
	}

	const locationalLoopError = getLocationalLoopError(agentConfig);
	if (locationalLoopError) return makeErrorResult(agentConfig.id, task, locationalLoopError, step, session);

	const requestedCwd = resolveOptionalCwd(defaultCwd, cwd);
	const effectiveCwd = agentConfig.kind === "locational" ? agentConfig.rootDir : requestedCwd ?? defaultCwd;

	if (agentConfig.kind === "locational" && requestedCwd && path.resolve(requestedCwd) !== path.resolve(agentConfig.rootDir)) {
		return makeErrorResult(
			agentConfig.id,
			task,
			`Invalid configuration: locational agent "${agentConfig.id}" runs from its source root. Omit cwd or use the same path (${agentConfig.rootDir}).`,
			step,
			session,
		);
	}

	const toolError = validateAgentTools(agentConfig);
	if (toolError) return makeErrorResult(agentConfig.id, task, toolError, step, session);

	const requiredSession = getRequiredSessionIntent(ctx, agentConfig);
	if (session !== requiredSession.intent) {
		const retry = getWrongIntentRetry(requiredSession.intent, requiredSession.reason);
		return makeErrorResult(
			agentConfig.id,
			task,
			formatWrongIntentReason(agentConfig, session, requiredSession.intent, requiredSession.reason),
			step,
			session,
			{
				agentOrigin: agentConfig.origin,
				wrongSessionIntent: { agentId: agentConfig.id, requested: session, required: requiredSession.intent, recommendedRetry: retry },
			},
		);
	}

	if (agentConfig.kind === "behavioral" && requestedCwd) {
		const locationalRoots = scanLocationalAgents(defaultCwd).agents.map((locationalAgent) => locationalAgent.rootDir);
		const blocked = locationalRoots.find((root) => isPathInside(requestedCwd, root));
		if (blocked) {
			notifyLocationalBoundaryDiscovered(ctx, blocked);
			return makeErrorResult(
				agentConfig.id,
				task,
				`Locational boundary enforced: use subprocess locational agent id "${blocked}" instead of running behavioral agent "${agentConfig.id}" with cwd inside it.`,
				step,
				session,
			);
		}
	}

	const resolvedModel = resolveAgentModel(agentConfig, ctx);
	const shouldRetryWithCaller = shouldRetryWithCallerModel(agentConfig, resolvedModel);
	let subprocessSessionId = agentConfig.resumable && subprocessSettings.reuseEnabled
		? session === "resume"
			? requiredSession.record?.sessionId
			: crypto.randomUUID()
		: undefined;
	if (!subprocessSessionId && shouldRetryWithCaller) subprocessSessionId = crypto.randomUUID();

	async function runAgentAttempt(model: ResolvedAgentModel): Promise<SingleResult> {
		const args: string[] = ["--mode", "json", "-p"];
		if (subprocessSessionId) args.push("--session-id", subprocessSessionId);
		else args.push("--no-session");
		if (model.model) args.push("--model", model.model);
		if (agentConfig.tools && agentConfig.tools.length > 0) args.push("--tools", agentConfig.tools.join(","));

		let tmpPromptDir: string | null = null;
		let tmpPromptPath: string | null = null;

		const lifecycle = createSubprocessLifecycle("agent", agentConfig.id);
		const currentResult: SingleResult = {
			kind: "agent",
			agent: agentConfig.id,
			agentOrigin: agentConfig.origin,
			sessionIntent: session,
			task,
			exitCode: 0,
			messages: [],
			stderr: "",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
			model: model.model,
			contextWindow: model.contextWindow,
			warning: model.warning,
			step,
			cwd: effectiveCwd,
		};

		const updateLifecycleResultFields = () => {
			const snapshot = getSubprocessLifecycleSnapshot(lifecycle);
			if (snapshot.phase === "closed") currentResult.exitCode = snapshot.exitCode;
		};

		const emitUpdate = () => {
			if (onUpdate) {
				updateLifecycleResultFields();
				onUpdate({
					content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
					details: makeDetails([currentResult]),
				});
			}
		};

		try {
			if (agentConfig.systemPrompt.trim()) {
				const prompt =
					agentConfig.kind === "locational"
						? `# ${getAgentInstructionsFileName()}\n\nThe following ${getAgentInstructionsFileName()} is more specific than any AGENTS.md loaded from the same folder. Follow it for this source root.\n\n${agentConfig.systemPrompt}`
						: agentConfig.systemPrompt;
				const tmp = await writePromptToTempFile(agentConfig.id, prompt);
				tmpPromptDir = tmp.dir;
				tmpPromptPath = tmp.filePath;
				args.push("--append-system-prompt", tmpPromptPath);
			}

			args.push(`Task: ${task}`);
			let wasAborted = false;

			const exitCode = await new Promise<number>((resolve) => {
				const invocation = getPiInvocation(args);
				const childEnv = {
					...process.env,
					...makeSubprocessChildEnv(agentConfig, currentDepth, includeLocationalAgentsInBehavioralChild),
				};
				const proc = spawn(invocation.command, invocation.args, {
					cwd: effectiveCwd,
					env: childEnv,
					shell: false,
					stdio: ["ignore", "pipe", "pipe"],
				});
				markSubprocessActivity(lifecycle);
				let buffer = "";

				const processLine = (line: string) => {
					if (!line.trim()) return;
					markSubprocessActivity(lifecycle);
					let event: any;
					try {
						event = JSON.parse(line);
					} catch {
						return;
					}
					processChildJsonEvent(event, currentResult, emitUpdate);
				};

				proc.stdout.on("data", (data) => {
					markSubprocessActivity(lifecycle);
					buffer += data.toString();
					const lines = buffer.split("\n");
					buffer = lines.pop() || "";
					for (const line of lines) processLine(line);
				});

				proc.stderr.on("data", (data) => {
					markSubprocessActivity(lifecycle);
					currentResult.stderr += data.toString();
				});

				proc.on("close", (code) => {
					if (buffer.trim()) processLine(buffer);
					const finalCode = code ?? 0;
					markSubprocessClosed(lifecycle, finalCode);
					resolve(finalCode);
				});

				proc.on("error", (error) => {
					recordSubprocessError(lifecycle, error.message);
					markSubprocessClosed(lifecycle, 1);
					resolve(1);
				});

				if (signal) {
					const killProc = () => {
						const changed = markSubprocessTerminating(lifecycle, "aborted", { timedOut: false });
						if (!changed) return;
						wasAborted = true;
						proc.kill("SIGTERM");
						setTimeout(() => {
							if (!proc.killed) proc.kill("SIGKILL");
						}, 5000);
					};
					if (signal.aborted) killProc();
					else signal.addEventListener("abort", killProc, { once: true });
				}
			});

			if (lifecycle.exitCode === undefined) markSubprocessClosed(lifecycle, exitCode);
			updateLifecycleResultFields();
			if (wasAborted) throw new Error("Subprocess agent was aborted");
			return currentResult;
		} finally {
			if (tmpPromptPath)
				try {
					fs.unlinkSync(tmpPromptPath);
				} catch {
					/* ignore */
				}
			if (tmpPromptDir)
				try {
					fs.rmdirSync(tmpPromptDir);
				} catch {
					/* ignore */
				}
		}
	}

	const firstResult = await runAgentAttempt(resolvedModel);
	let finalResult = firstResult;

	if (shouldRetryWithCaller && shouldRetryPreferredModelFailure(firstResult)) {
		const fallbackModel: ResolvedAgentModel = {
			model: resolvedModel.fallbackModel,
			contextWindow: resolvedModel.fallbackContextWindow,
			source: "caller",
		};
		finalResult = await runAgentAttempt(fallbackModel);
		appendWarning(
			finalResult,
			`${resolvedModel.source === "agent" ? "Explicit locational model" : "Preferred locational model"} ${firstResult.model ?? "(default)"} failed before task work; retried with caller model ${finalResult.model ?? "(default)"}.`,
		);
	}

	updateTrackedSession(ctx, agentConfig, subprocessSessionId, finalResult);
	if (agentConfig.resumable) persistSubprocessState(pi);
	return finalResult;
}

export async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}
