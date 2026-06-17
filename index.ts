/**
 * Subprocess Tool - Delegate tasks to specialized agents and command subprocesses
 *
 * Spawns a separate `pi` process for each agent invocation,
 * giving it an isolated context window.
 *
 * Supports three modes:
 *   - Single: { id: "name-or-location-path", session: "new|resume", task: "..." }
 *   - Parallel: { tasks: [{ id: "name-or-location-path", session: "new|resume", task: "..." }, ...] }
 *   - Chain: { chain: [{ id: "name-or-location-path", session: "new|resume", task: "... {previous} ..." }, ...] }
 *   - Commands: { commands: [{ command: "npm test", cwd: ".", timeoutMs: 120000 }, ...] }
 *
 * Uses JSON mode to capture structured output from subprocess agents.
 */

import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "./pi-compat.ts";
import {
	type AgentConfig,
	type AgentScope,
	discoverAgents,
	getAgentInstructionsFileName,
	isPathInside,
	loadLocationalAgent,
} from "./agents.ts";
import { ADVERTISE_LOCATIONAL_AGENTS_ENV, CURRENT_LOCATIONAL_ROOT_ENV, DEFAULT_KNOWN_TOOLS, MAX_CONCURRENCY, MAX_PARALLEL_TASKS } from "./constants.ts";
import { runCommandTask, type CommandTaskInput } from "./command.ts";
import { mapWithConcurrencyLimit, resolveAgent, runDelegation, setKnownToolNames, validateAgentTools } from "./execution.ts";
import { addHandoffDocsToTask, getAgentId, getMissingSessionError } from "./params.ts";
import { formatLocalLocationalPrompt, formatSubprocessAgentManifest } from "./prompt.ts";
import { getFinalOutput, getResultOutput, isFailedResult, makeErrorResult, truncateParallelOutput } from "./result.ts";
import { SubprocessParams } from "./schema.ts";
import { commandFilesystemTargets, getGuardedLocationalRoots, getLocationalLoopError, notifyLocationalBoundaryDiscovered, resolveFilesystemTarget } from "./locational-guard.ts";
import { getMainSessionKey, persistSubprocessState, restoreSubprocessState, subprocessSettings, trackedSessions } from "./state.ts";
import { renderSubprocessCall, renderSubprocessResult } from "./render.ts";
import type { OnUpdateCallback, SessionIntent, SingleResult, SubprocessDetails } from "./types.ts";

export { getFinalOutput } from "./result.ts";

type AgentTaskInput = {
	id?: string;
	session?: SessionIntent;
	task: string;
	cwd?: string;
	contextDocs?: string[];
	handoffDocs?: string[];
};

type SubprocessToolParams = {
	id?: string;
	session?: SessionIntent;
	task?: string;
	cwd?: string;
	contextDocs?: string[];
	handoffDocs?: string[];
	tasks?: AgentTaskInput[];
	chain?: AgentTaskInput[];
	commands?: CommandTaskInput[];
	agentScope?: AgentScope;
	confirmProjectAgents?: boolean;
	includeLocationalAgents?: boolean;
};

function shouldAdvertiseLocationalAgents(): boolean {
	const value = process.env[ADVERTISE_LOCATIONAL_AGENTS_ENV]?.trim().toLowerCase();
	return value !== "0" && value !== "false" && value !== "no" && value !== "off";
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => restoreSubprocessState(ctx));
	pi.on("session_tree", async (_event, ctx) => restoreSubprocessState(ctx));

	const settingsCommand = {
		description: "Configure subprocess-agent session reuse and context threshold",
		handler: async (_args: unknown, ctx: ExtensionContext) => {
			restoreSubprocessState(ctx);
			while (true) {
				const sessionKey = getMainSessionKey(ctx);
				const active = Array.from(trackedSessions.values()).filter((record) => record.mainSessionKey === sessionKey);
				const choice = await ctx.ui.select("Subprocess settings", [
					`Reuse: ${subprocessSettings.reuseEnabled ? "enabled" : "disabled"}`,
					`Context threshold: ${Math.round(subprocessSettings.contextThreshold * 100)}%`,
					`Active resumable sessions: ${active.length}`,
					"Reset tracked resumable sessions",
					"Close",
				]);
				if (!choice || choice === "Close") return;
				if (choice.startsWith("Reuse:")) {
					subprocessSettings.reuseEnabled = !subprocessSettings.reuseEnabled;
					persistSubprocessState(pi);
					ctx.ui.notify(`Subprocess reuse ${subprocessSettings.reuseEnabled ? "enabled" : "disabled"}.`, "info");
				} else if (choice.startsWith("Context threshold:")) {
					const input = await ctx.ui.input("Context threshold percent", String(Math.round(subprocessSettings.contextThreshold * 100)));
					if (!input) continue;
					const percent = Number(input.trim().replace(/%$/, ""));
					if (!Number.isFinite(percent) || percent <= 0 || percent > 100) {
						ctx.ui.notify("Threshold must be between 1 and 100.", "error");
						continue;
					}
					subprocessSettings.contextThreshold = percent / 100;
					persistSubprocessState(pi);
				} else if (choice.startsWith("Active resumable sessions:")) {
					const lines = active.length === 0
						? ["No active resumable sessions."]
						: active.map((record) => `${record.agentId}: next session \"${record.nextIntent}\"${record.contextWindow ? ` (${record.contextTokens}/${record.contextWindow} tokens)` : ""}`);
					ctx.ui.notify(lines.join("\n"), "info");
				} else if (choice === "Reset tracked resumable sessions") {
					const ok = await ctx.ui.confirm("Reset subprocess sessions?", "Clear tracked resumable subprocess-agent sessions for the current main session.");
					if (!ok) continue;
					for (const [key, record] of trackedSessions) if (record.mainSessionKey === sessionKey) trackedSessions.delete(key);
					persistSubprocessState(pi);
					ctx.ui.notify("Tracked resumable subprocess sessions reset.", "info");
				}
			}
		},
	};
	pi.registerCommand("subprocess-settings", settingsCommand);

	pi.on("before_agent_start", async (event, ctx) => {
		setKnownToolNames([
			...DEFAULT_KNOWN_TOOLS,
			...Object.keys(event.systemPromptOptions.toolSnippets ?? {}),
			...(event.systemPromptOptions.selectedTools ?? []),
		]);

		const advertiseLocationalAgents = shouldAdvertiseLocationalAgents();
		const discovery = discoverAgents(ctx.cwd, "user", { includeLocationalAgents: advertiseLocationalAgents });
		const manifest = formatSubprocessAgentManifest(discovery.agents);
		const promptParts: string[] = [];

		if (manifest) {
			promptParts.push(
				`Subprocess agents can be delegated to with the subprocess tool by id and required session intent ("new" or "resume"). Use session: "new" for a first/fresh call; use session: "resume" only when the previous result for that same subprocess agent said to. Locational agent ids are locational boundaries; by default, do not read, search, edit, or run commands inside those folders directly from this agent. If the user explicitly authorizes direct access for a specific source root and task, direct access is allowed for that user request only. Do not delegate a locational agent to its own current source root or an active source ancestor; the tool blocks recursive source loops.\n\n${manifest}`,
			);
		}

		const activeLocationalRoot = process.env[CURRENT_LOCATIONAL_ROOT_ENV];
		if (advertiseLocationalAgents && (!activeLocationalRoot || path.resolve(activeLocationalRoot) !== path.resolve(ctx.cwd))) {
			const local = loadLocationalAgent(ctx.cwd, { readBody: true });
			if (local.agent) {
				promptParts.push(formatLocalLocationalPrompt(ctx, event.systemPromptOptions, path.join(path.resolve(ctx.cwd), getAgentInstructionsFileName()), local.agent.systemPrompt));
			}
		}

		const configErrors = [...discovery.errors, ...discovery.agents.map(validateAgentTools).filter((error): error is string => Boolean(error))];
		if (configErrors.length > 0) {
			promptParts.push(`Subprocess agent configuration errors:\n${configErrors.map((error) => `- ${error}`).join("\n")}`);
		}

		if (promptParts.length === 0) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${promptParts.join("\n\n")}` };
	});

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName === "subprocess") return;
		const locationalRoots = getGuardedLocationalRoots(ctx.cwd);
		if (locationalRoots.length === 0) return;

		const input = (event.input ?? {}) as Record<string, unknown>;
		const pathKeys = ["path", "file_path", "filePath", "cwd", "dir", "directory", "root", "rootDir"];
		const candidatePaths: string[] = [];
		for (const key of pathKeys) {
			const value = input[key];
			if (typeof value === "string" && value.trim()) {
				const target = resolveFilesystemTarget(ctx.cwd, value, { allowBare: true });
				if (target) candidatePaths.push(target);
			}
		}

		if (event.toolName === "bash") {
			const bashCwd = typeof input.cwd === "string"
				? resolveFilesystemTarget(ctx.cwd, input.cwd, { allowBare: true }) ?? path.resolve(ctx.cwd, input.cwd)
				: ctx.cwd;
			candidatePaths.push(bashCwd);
			const command = typeof input.command === "string" ? input.command : "";
			candidatePaths.push(...commandFilesystemTargets(command, bashCwd));
		}

		for (const candidate of candidatePaths) {
			const root = locationalRoots.find((locationalRoot) => isPathInside(candidate, locationalRoot));
			if (root) {
				notifyLocationalBoundaryDiscovered(ctx, root);
				return {
					block: true,
					reason: `Locational boundary enforced: delegate to subprocess locational agent id "${root}" instead of accessing it directly.`,
				};
			}
		}
	});

	const subprocessTool: any = {
		name: "subprocess",
		label: "Subprocess",
		description: [
			"Run foreground-managed subprocess work: specialized Pi agents with isolated context, or shell commands.",
			"Modes: single agent (id + session + task), parallel agents (tasks array), chain (sequential with {previous} placeholder), commands (command task array).",
			"Every agent delegation must include session: \"new\" or \"resume\"; use \"resume\" only when the previous result for that subprocess agent said so.",
			"Use id for behavioral agents and locational agents; behavioral agents run from the caller cwd by default, locational agents run from their source root.",
			"Locational ids are absolute or caller-cwd-relative folders containing SUBAGENTS.md; direct access is allowed only when the user explicitly authorizes it for the current request; recursive locational delegation to the current source root or active source stack is blocked.",
			"For locational agents, include relevant director/project docs with contextDocs or handoffDocs so the child reads them before starting.",
			"Command tasks are foreground-managed: the tool streams progress, waits for completion, and returns consolidated results; it does not create detached jobs or jobId polling.",
			"Behavioral-agent child sessions do not advertise locational agents by default; set includeLocationalAgents true when a behavioral agent should orchestrate locational agents.",
			'Default behavioral agent scope is "user" (from ~/.pi/agent/agents).',
			'To enable project-local behavioral agents in .pi/agents, set agentScope: "both" (or "project").',
		].join(" "),
		promptSnippet:
			"Run foreground-managed subprocess work: specialized Pi agents with isolated context, or shell commands; streams progress, waits for completion, and returns consolidated results.",
		parameters: SubprocessParams,

		async execute(_toolCallId: string, params: SubprocessToolParams, signal: AbortSignal | undefined, onUpdate: OnUpdateCallback | undefined, ctx: ExtensionContext) {
			const agentScope: AgentScope = params.agentScope ?? "user";
			const includeLocationalAgents = params.includeLocationalAgents ?? false;
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;
			const confirmProjectAgents = params.confirmProjectAgents ?? true;

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasCommands = (params.commands?.length ?? 0) > 0;
			const singleId = getAgentId(params);
			const hasSingle = Boolean(singleId && params.task);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasCommands) + Number(hasSingle);

			const makeDetails =
				(mode: "single" | "parallel" | "chain") =>
				(results: SingleResult[]): SubprocessDetails => ({
					mode,
					agentScope,
					includeLocationalAgents,
					projectAgentsDir: discovery.projectAgentsDir,
					locationalAgents: discovery.locationalAgents.map((agent) => agent.id),
					results,
				});

			if (modeCount !== 1) {
				const available = agents.map((a) => `${a.id} (${a.origin})`).join(", ") || "none";
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${available}`,
						},
					],
					details: makeDetails("single")([]),
					isError: true,
				};
			}

			const mode = hasChain ? "chain" : hasTasks || hasCommands ? "parallel" : "single";
			const missingSessionError = getMissingSessionError(params);
			if (missingSessionError) {
				return {
					content: [{ type: "text", text: missingSessionError }],
					details: makeDetails(mode)([]),
					isError: true,
				};
			}
			const requestedDelegations: Array<{ id: string | undefined; session?: SessionIntent; task: string; step?: number }> = hasChain
				? params.chain!.map((step, index) => ({ id: getAgentId(step), session: step.session, task: step.task, step: index + 1 }))
				: hasTasks
					? params.tasks!.map((task) => ({ id: getAgentId(task), session: task.session, task: task.task }))
					: hasSingle
						? [{ id: singleId, session: params.session, task: params.task ?? "" }]
						: [];
			for (const requested of requestedDelegations) {
				if (!requested.id) continue;
				const agent = resolveAgent(ctx.cwd, agents, requested.id);
				if (!agent) continue;
				const locationalLoopError = getLocationalLoopError(agent);
				if (locationalLoopError) {
					const result = makeErrorResult(agent.id, requested.task, locationalLoopError, requested.step, requested.session);
					return {
						content: [{ type: "text", text: locationalLoopError }],
						details: makeDetails(mode)([result]),
						isError: true,
					};
				}
			}

			if ((agentScope === "project" || agentScope === "both") && confirmProjectAgents && ctx.hasUI) {
				const requestedAgentIds = new Set<string>();
				if (params.chain) for (const step of params.chain) requestedAgentIds.add(getAgentId(step) ?? "");
				if (params.tasks) for (const t of params.tasks) requestedAgentIds.add(getAgentId(t) ?? "");
				if (singleId) requestedAgentIds.add(singleId);

				const projectAgentsRequested = Array.from(requestedAgentIds)
					.map((id) => agents.find((a) => a.id === id))
					.filter((a): a is AgentConfig => a?.origin === "project");

				if (projectAgentsRequested.length > 0) {
					const names = projectAgentsRequested.map((a) => a.id).join(", ");
					const dir = discovery.projectAgentsDir ?? "(unknown)";
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${names}\nLocation: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok)
						return {
							content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
							details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
						};
				}
			}

			if (params.commands && params.commands.length > 0) {
				const locationalRoots = getGuardedLocationalRoots(ctx.cwd);
				for (const commandTask of params.commands) {
					const commandCwd = commandTask.cwd ? path.resolve(ctx.cwd, commandTask.cwd) : ctx.cwd;
					const candidates = [commandCwd, ...commandFilesystemTargets(commandTask.command, commandCwd)];
					const blockedRoot = candidates
						.map((candidate) => locationalRoots.find((root) => isPathInside(candidate, root)))
						.find((root): root is string => Boolean(root));
					if (blockedRoot) {
						notifyLocationalBoundaryDiscovered(ctx, blockedRoot);
						return {
							content: [{ type: "text", text: `Locational boundary enforced: delegate to subprocess locational agent id "${blockedRoot}" instead of running a command inside it.` }],
							details: makeDetails("parallel")([]),
							isError: true,
						};
					}
				}

				if (params.commands.length > MAX_PARALLEL_TASKS)
					return {
						content: [
							{
								type: "text",
								text: `Too many command tasks (${params.commands.length}). Max is ${MAX_PARALLEL_TASKS}.`,
							},
						],
						details: makeDetails("parallel")([]),
					};

				const allResults: SingleResult[] = params.commands.map((commandTask) => ({
					kind: "command",
					agent: commandTask.name?.trim() || commandTask.command,
					agentOrigin: "unknown",
					task: commandTask.command,
					command: commandTask.command,
					exitCode: -1,
					messages: [],
					stdout: "",
					stderr: "",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
					cwd: commandTask.cwd ? path.resolve(ctx.cwd, commandTask.cwd) : ctx.cwd,
					timeoutMs: commandTask.timeoutMs,
				}));

				const emitCommandUpdate = () => {
					if (!onUpdate) return;
					const running = allResults.filter((r) => r.exitCode === -1).length;
					const done = allResults.length - running;
					onUpdate({
						content: [{ type: "text", text: `Commands: ${done}/${allResults.length} done, ${running} running...` }],
						details: makeDetails("parallel")([...allResults]),
					});
				};

				const results = await mapWithConcurrencyLimit(params.commands, MAX_CONCURRENCY, async (commandTask, index) => {
					const result = await runCommandTask(ctx.cwd, commandTask, undefined, signal, (partial) => {
						allResults[index] = partial;
						emitCommandUpdate();
					});
					allResults[index] = result;
					emitCommandUpdate();
					return result;
				});

				const successCount = results.filter((r) => !isFailedResult(r)).length;
				const summaries = results.map((r) => {
					const output = truncateParallelOutput(getResultOutput(r));
					const status = isFailedResult(r) ? `failed (exit ${r.exitCode})` : "completed";
					return `### [${r.agent}] ${status}\n\n${output}`;
				});
				return {
					content: [
						{
							type: "text",
							text: `Commands: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
						},
					],
					details: makeDetails("parallel")(results),
					isError: successCount !== results.length,
				};
			}

			if (params.chain && params.chain.length > 0) {
				const results: SingleResult[] = [];
				let previousOutput = "";

				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					const stepId = getAgentId(step);
					if (!stepId) {
						return {
							content: [{ type: "text", text: `Chain stopped at step ${i + 1}: missing subprocess agent id.` }],
							details: makeDetails("chain")(results),
							isError: true,
						};
					}
					const taskWithContext = addHandoffDocsToTask(step.task.replace(/\{previous\}/g, previousOutput), step);

					// Create update callback that includes all previous results
					const chainUpdate: OnUpdateCallback | undefined = onUpdate
						? (partial) => {
								// Combine completed results with current streaming result
								const currentResult = partial.details?.results[0];
								if (currentResult) {
									const allResults = [...results, currentResult];
									onUpdate({
										content: partial.content,
										details: makeDetails("chain")(allResults),
									});
								}
							}
						: undefined;

					const result = await runDelegation(
						pi,
						ctx,
						ctx.cwd,
						agents,
						stepId,
						step.session as SessionIntent,
						taskWithContext,
						step.cwd,
						i + 1,
						signal,
						chainUpdate,
						makeDetails("chain"),
						includeLocationalAgents,
					);
					results.push(result);

					const isError = isFailedResult(result);
					if (isError) {
						const errorMsg = getResultOutput(result);
						return {
							content: [{ type: "text", text: `Chain stopped at step ${i + 1} (${stepId}): ${errorMsg}` }],
							details: makeDetails("chain")(results),
							isError: true,
						};
					}
					previousOutput = getFinalOutput(result.messages);
				}
				return {
					content: [{ type: "text", text: getResultOutput(results[results.length - 1]) }],
					details: makeDetails("chain")(results),
				};
			}

			if (params.tasks && params.tasks.length > 0) {
				if (params.tasks.length > MAX_PARALLEL_TASKS)
					return {
						content: [
							{
								type: "text",
								text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
							},
						],
						details: makeDetails("parallel")([]),
					};

				// Track all results for streaming updates
				const allResults: SingleResult[] = new Array(params.tasks.length);

				// Initialize placeholder results
				for (let i = 0; i < params.tasks.length; i++) {
					allResults[i] = {
						agent: getAgentId(params.tasks[i]) ?? "(missing id)",
						agentOrigin: "unknown",
						sessionIntent: params.tasks[i].session,
						task: params.tasks[i].task,
						exitCode: -1, // -1 = still running
						messages: [],
						stderr: "",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
					};
				}

				const emitParallelUpdate = () => {
					if (onUpdate) {
						const running = allResults.filter((r) => r.exitCode === -1).length;
						const done = allResults.filter((r) => r.exitCode !== -1).length;
						onUpdate({
							content: [
								{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` },
							],
							details: makeDetails("parallel")([...allResults]),
						});
					}
				};

				const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (t, index) => {
					const taskId = getAgentId(t);
					if (!taskId) return makeErrorResult("(missing id)", t.task, "Missing subprocess agent id.", undefined, t.session);
					const result = await runDelegation(
						pi,
						ctx,
						ctx.cwd,
						agents,
						taskId,
						t.session as SessionIntent,
						addHandoffDocsToTask(t.task, t),
						t.cwd,
						undefined,
						signal,
						// Per-task update callback
						(partial) => {
							if (partial.details?.results[0]) {
								allResults[index] = partial.details.results[0];
								emitParallelUpdate();
							}
						},
						makeDetails("parallel"),
						includeLocationalAgents,
					);
					allResults[index] = result;
					emitParallelUpdate();
					return result;
				});

				const successCount = results.filter((r) => !isFailedResult(r)).length;
				const summaries = results.map((r) => {
					const output = truncateParallelOutput(getResultOutput(r));
					const status = isFailedResult(r)
						? `failed${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}`
						: "completed";
					return `### [${r.agent}] ${status}\n\n${output}`;
				});
				return {
					content: [
						{
							type: "text",
							text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
						},
					],
					details: makeDetails("parallel")(results),
				};
			}

			if (singleId && params.task) {
				const result = await runDelegation(
					pi,
					ctx,
					ctx.cwd,
					agents,
					singleId,
					params.session as SessionIntent,
					addHandoffDocsToTask(params.task, params),
					params.cwd,
					undefined,
					signal,
					onUpdate,
					makeDetails("single"),
					includeLocationalAgents,
				);
				const isError = isFailedResult(result);
				if (isError) {
					const errorMsg = getResultOutput(result);
					return {
						content: [{ type: "text", text: `Agent ${result.stopReason || "failed"}: ${errorMsg}` }],
						details: makeDetails("single")([result]),
						isError: true,
					};
				}
				return {
					content: [{ type: "text", text: getResultOutput(result) }],
					details: makeDetails("single")([result]),
				};
			}

			const available = agents.map((a) => `${a.id} (${a.origin})`).join(", ") || "none";
			return {
				content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
				details: makeDetails("single")([]),
			};
		},

		renderCall: renderSubprocessCall,
		renderResult: renderSubprocessResult,
	};

	pi.registerTool(subprocessTool);
}
