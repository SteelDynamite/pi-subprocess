import { spawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";
import type { AgentConfig } from "./agents.ts";
import { getSubagentsFileName, isPathInside, resolveLocationalAgentId, scanLocationalAgents } from "./agents.ts";
import { ADVERTISE_LOCATIONAL_AGENTS_ENV, DEFAULT_KNOWN_TOOLS, LEGACY_ADVERTISE_LOCATIONAL_AGENTS_ENV, LEGACY_ADVERTISE_SOURCE_AGENTS_ENV, LEGACY_SUBAGENT_CHILD_ENV, LEGACY_SUBAGENT_DEPTH_ENV, MAX_SUBPROCESS_DEPTH, ORCHESTRATED_CHILD_ENV, SUBPROCESS_CHILD_ENV, SUBPROCESS_DEPTH_ENV } from "./constants.ts";
import { createSubprocessLifecycle, getSubprocessLifecycleSnapshot, markSubprocessActivity, markSubprocessClosed, markSubprocessTerminating, recordSubprocessError } from "./lifecycle.ts";
import { applyNestedSubprocessEvent } from "./nested.ts";
import { getFinalOutput, makeErrorResult } from "./result.ts";
import { formatWrongIntentReason, getRequiredSessionIntent, getWrongIntentRetry, persistSubagentState, subagentSettings, updateTrackedSession } from "./state.ts";
import { getLocationalLoopError, makeChildLocationalEnv, notifyLocationalBoundaryDiscovered } from "./locational-guard.ts";
import type { OnUpdateCallback, SessionIntent, SingleResult, SubagentDetails } from "./types.ts";

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

function resolveAgentModel(agent: AgentConfig, ctx: ExtensionContext): { model?: string; contextWindow?: number; warning?: string } {
	const callerModel = formatModelRef(ctx.model);
	const callerContextWindow = (ctx.model as any)?.contextWindow;
	if (!agent.model?.trim()) return { model: callerModel, contextWindow: callerContextWindow };

	const candidates = agent.model
		.split(",")
		.map((m) => m.trim())
		.filter(Boolean);
	const available = ctx.modelRegistry.getAvailable();

	for (const candidate of candidates) {
		const match = available.find((model) => `${model.provider}/${model.id}` === candidate || model.id === candidate);
		if (match) return { model: `${match.provider}/${match.id}`, contextWindow: (match as any).contextWindow };
	}

	return {
		model: callerModel,
		contextWindow: callerContextWindow,
		warning: `No configured model from "${agent.model}" for ${agent.id}; using caller model${callerModel ? ` ${callerModel}` : ""}.`,
	};
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
		[LEGACY_SUBAGENT_DEPTH_ENV]: depth,
		[SUBPROCESS_CHILD_ENV]: "1",
		[LEGACY_SUBAGENT_CHILD_ENV]: "1",
		[ORCHESTRATED_CHILD_ENV]: "1",
		[ADVERTISE_LOCATIONAL_AGENTS_ENV]: advertiseLocationalAgents,
		[LEGACY_ADVERTISE_LOCATIONAL_AGENTS_ENV]: advertiseLocationalAgents,
		[LEGACY_ADVERTISE_SOURCE_AGENTS_ENV]: advertiseLocationalAgents,
		...makeChildLocationalEnv(agent),
	};
}

export const makeSubagentChildEnv = makeSubprocessChildEnv;

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
	makeDetails: (results: SingleResult[]) => SubagentDetails,
	includeLocationalAgentsInBehavioralChild: boolean,
): Promise<SingleResult> {
	const agent = resolveAgent(defaultCwd, agents, agentId);

	if (!agent) {
		const available = agents.map((a) => `"${a.id}"`).join(", ") || "none";
		return makeErrorResult(agentId, task, `Unknown subprocess agent id: "${agentId}". Available agents: ${available}.`, step, session);
	}

	const currentDepth = Number(process.env[SUBPROCESS_DEPTH_ENV] ?? process.env[LEGACY_SUBAGENT_DEPTH_ENV] ?? "0");
	if (currentDepth >= MAX_SUBPROCESS_DEPTH) {
		return makeErrorResult(agent.id, task, `Subprocess recursion limit reached (max depth ${MAX_SUBPROCESS_DEPTH}).`, step, session);
	}

	const locationalLoopError = getLocationalLoopError(agent);
	if (locationalLoopError) return makeErrorResult(agent.id, task, locationalLoopError, step, session);

	const requestedCwd = resolveOptionalCwd(defaultCwd, cwd);
	const effectiveCwd = agent.kind === "locational" ? agent.rootDir : requestedCwd ?? defaultCwd;

	if (agent.kind === "locational" && requestedCwd && path.resolve(requestedCwd) !== path.resolve(agent.rootDir)) {
		return makeErrorResult(
			agent.id,
			task,
			`Invalid configuration: locational agent "${agent.id}" runs from its source root. Omit cwd or use the same path (${agent.rootDir}).`,
			step,
			session,
		);
	}

	const toolError = validateAgentTools(agent);
	if (toolError) return makeErrorResult(agent.id, task, toolError, step, session);

	const requiredSession = getRequiredSessionIntent(ctx, agent);
	if (session !== requiredSession.intent) {
		const retry = getWrongIntentRetry(requiredSession.intent, requiredSession.reason);
		return makeErrorResult(
			agent.id,
			task,
			formatWrongIntentReason(agent, session, requiredSession.intent, requiredSession.reason),
			step,
			session,
			{
				agentOrigin: agent.origin,
				wrongSessionIntent: { agentId: agent.id, requested: session, required: requiredSession.intent, recommendedRetry: retry },
			},
		);
	}

	if (agent.kind === "behavioral" && requestedCwd) {
		const locationalRoots = scanLocationalAgents(defaultCwd).agents.map((locationalAgent) => locationalAgent.rootDir);
		const blocked = locationalRoots.find((root) => isPathInside(requestedCwd, root));
		if (blocked) {
			notifyLocationalBoundaryDiscovered(ctx, blocked);
			return makeErrorResult(
				agent.id,
				task,
				`Locational boundary enforced: use subprocess locational agent id "${blocked}" instead of running behavioral agent "${agent.id}" with cwd inside it.`,
				step,
				session,
			);
		}
	}

	const resolvedModel = resolveAgentModel(agent, ctx);
	const subagentSessionId = agent.resumable && subagentSettings.reuseEnabled
		? session === "resume"
			? requiredSession.record?.sessionId
			: crypto.randomUUID()
		: undefined;
	const args: string[] = ["--mode", "json", "-p"];
	if (subagentSessionId) args.push("--session-id", subagentSessionId);
	else args.push("--no-session");
	if (resolvedModel.model) args.push("--model", resolvedModel.model);
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	const lifecycle = createSubprocessLifecycle("subagent", agent.id);
	const currentResult: SingleResult = {
		agent: agent.id,
		agentOrigin: agent.origin,
		sessionIntent: session,
		task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model: resolvedModel.model,
		contextWindow: resolvedModel.contextWindow,
		warning: resolvedModel.warning,
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
		if (agent.systemPrompt.trim()) {
			const prompt =
				agent.kind === "locational"
					? `# ${getSubagentsFileName()}\n\nThe following ${getSubagentsFileName()} is more specific than any AGENTS.md loaded from the same folder. Follow it for this source root.\n\n${agent.systemPrompt}`
					: agent.systemPrompt;
			const tmp = await writePromptToTempFile(agent.id, prompt);
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
				...makeSubprocessChildEnv(agent, currentDepth, includeLocationalAgentsInBehavioralChild),
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
		updateTrackedSession(ctx, agent, subagentSessionId, currentResult);
		if (agent.resumable) persistSubagentState(pi);
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
