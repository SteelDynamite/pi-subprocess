/**
 * Subagent Tool - Delegate tasks to specialized agents
 *
 * Spawns a separate `pi` process for each subagent invocation,
 * giving it an isolated context window.
 *
 * Supports three modes:
 *   - Single: { id: "name-or-source-path", session: "new|resume", task: "..." }
 *   - Parallel: { tasks: [{ id: "name-or-source-path", session: "new|resume", task: "..." }, ...] }
 *   - Chain: { chain: [{ id: "name-or-source-path", session: "new|resume", task: "... {previous} ..." }, ...] }
 *
 * Uses JSON mode to capture structured output from subagents.
 */

import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type AgentConfig,
	type AgentScope,
	discoverAgents,
	getSubagentsFileName,
	isPathInside,
	loadSourceAgent,
} from "./agents.ts";
import { ADVERTISE_SOURCE_AGENTS_ENV, DEFAULT_KNOWN_TOOLS, MAX_CONCURRENCY, MAX_PARALLEL_TASKS } from "./constants.ts";
import { mapWithConcurrencyLimit, resolveAgent, runDelegation, setKnownToolNames, validateAgentTools } from "./execution.ts";
import { getAgentId, getMissingSessionError } from "./params.ts";
import { formatLocalSourcePrompt, formatSubagentManifest } from "./prompt.ts";
import { getFinalOutput, getResultOutput, isFailedResult, makeErrorResult, truncateParallelOutput } from "./result.ts";
import { SubagentParams } from "./schema.ts";
import { commandFilesystemTargets, getGuardedSourceRoots, getSourceLoopError, notifySourceBoundaryDiscovered, resolveFilesystemTarget } from "./source-guard.ts";
import { getMainSessionKey, persistSubagentState, restoreSubagentState, subagentSettings, trackedSessions } from "./state.ts";
import { renderSubagentCall, renderSubagentResult } from "./render.ts";
import type { OnUpdateCallback, SessionIntent, SingleResult, SubagentDetails } from "./types.ts";

export { getFinalOutput } from "./result.ts";

function shouldAdvertiseSourceAgents(): boolean {
	const value = process.env[ADVERTISE_SOURCE_AGENTS_ENV]?.trim().toLowerCase();
	return value !== "0" && value !== "false" && value !== "no" && value !== "off";
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => restoreSubagentState(ctx));
	pi.on("session_tree", async (_event, ctx) => restoreSubagentState(ctx));

	pi.registerCommand("subagent-settings", {
		description: "Configure subagent session reuse and context threshold",
		handler: async (_args, ctx) => {
			restoreSubagentState(ctx);
			while (true) {
				const sessionKey = getMainSessionKey(ctx);
				const active = Array.from(trackedSessions.values()).filter((record) => record.mainSessionKey === sessionKey);
				const choice = await ctx.ui.select("Subagent settings", [
					`Reuse: ${subagentSettings.reuseEnabled ? "enabled" : "disabled"}`,
					`Context threshold: ${Math.round(subagentSettings.contextThreshold * 100)}%`,
					`Active resumable sessions: ${active.length}`,
					"Reset tracked resumable sessions",
					"Close",
				]);
				if (!choice || choice === "Close") return;
				if (choice.startsWith("Reuse:")) {
					subagentSettings.reuseEnabled = !subagentSettings.reuseEnabled;
					persistSubagentState(pi);
					ctx.ui.notify(`Subagent reuse ${subagentSettings.reuseEnabled ? "enabled" : "disabled"}.`, "info");
				} else if (choice.startsWith("Context threshold:")) {
					const input = await ctx.ui.input("Context threshold percent", String(Math.round(subagentSettings.contextThreshold * 100)));
					if (!input) continue;
					const percent = Number(input.trim().replace(/%$/, ""));
					if (!Number.isFinite(percent) || percent <= 0 || percent > 100) {
						ctx.ui.notify("Threshold must be between 1 and 100.", "error");
						continue;
					}
					subagentSettings.contextThreshold = percent / 100;
					persistSubagentState(pi);
				} else if (choice.startsWith("Active resumable sessions:")) {
					const lines = active.length === 0
						? ["No active resumable sessions."]
						: active.map((record) => `${record.agentId}: next session \"${record.nextIntent}\"${record.contextWindow ? ` (${record.contextTokens}/${record.contextWindow} tokens)` : ""}`);
					ctx.ui.notify(lines.join("\n"), "info");
				} else if (choice === "Reset tracked resumable sessions") {
					const ok = await ctx.ui.confirm("Reset subagent sessions?", "Clear tracked resumable subagent sessions for the current main session.");
					if (!ok) continue;
					for (const [key, record] of trackedSessions) if (record.mainSessionKey === sessionKey) trackedSessions.delete(key);
					persistSubagentState(pi);
					ctx.ui.notify("Tracked resumable subagent sessions reset.", "info");
				}
			}
		},
	});

	pi.on("before_agent_start", async (event, ctx) => {
		setKnownToolNames([
			...DEFAULT_KNOWN_TOOLS,
			...Object.keys(event.systemPromptOptions.toolSnippets ?? {}),
			...(event.systemPromptOptions.selectedTools ?? []),
		]);

		const advertiseSourceAgents = shouldAdvertiseSourceAgents();
		const discovery = discoverAgents(ctx.cwd, "user", { includeSourceAgents: advertiseSourceAgents });
		const manifest = formatSubagentManifest(discovery.agents);
		const promptParts: string[] = [];

		if (manifest) {
			promptParts.push(
				`Subagents can be delegated to with the subagent tool by id and required session intent ("new" or "resume"). Use session: "new" for a first/fresh call; use session: "resume" only when the previous result for that same subagent said to. Locational subagent ids are locational boundaries; by default, do not read, search, edit, or run commands inside those folders directly from this agent. If the user explicitly authorizes direct access for a specific source root and task, direct access is allowed for that user request only. Do not delegate a locational agent to its own current source root or an active source ancestor; the tool blocks recursive source loops.\n\n${manifest}`,
			);
		}

		const skipLocalSubagents = process.env.PI_SUBAGENT_SKIP_LOCAL_SUBAGENTS;
		if (advertiseSourceAgents && (!skipLocalSubagents || path.resolve(skipLocalSubagents) !== path.resolve(ctx.cwd))) {
			const local = loadSourceAgent(ctx.cwd, { readBody: true });
			if (local.agent) {
				promptParts.push(formatLocalSourcePrompt(ctx, event.systemPromptOptions, path.join(path.resolve(ctx.cwd), getSubagentsFileName()), local.agent.systemPrompt));
			}
		}

		const configErrors = [...discovery.errors, ...discovery.agents.map(validateAgentTools).filter((error): error is string => Boolean(error))];
		if (configErrors.length > 0) {
			promptParts.push(`Subagent configuration errors:\n${configErrors.map((error) => `- ${error}`).join("\n")}`);
		}

		if (promptParts.length === 0) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${promptParts.join("\n\n")}` };
	});

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName === "subagent") return;
		const sourceRoots = getGuardedSourceRoots(ctx.cwd);
		if (sourceRoots.length === 0) return;

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
			const root = sourceRoots.find((sourceRoot) => isPathInside(candidate, sourceRoot));
			if (root) {
				notifySourceBoundaryDiscovered(ctx, root);
				return {
					block: true,
					reason: `Locational boundary enforced: delegate to subagent id "${root}" instead of accessing it directly.`,
				};
			}
		}
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to specialized subagents with isolated context.",
			"Modes: single (id + session + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
			"Every delegation must include session: \"new\" or \"resume\"; use \"resume\" only when the previous result for that subagent said so.",
			"Use id for behavioral agents and locational agents; behavioral agents run from the caller cwd by default, locational agents run from their source root.",
			"Locational ids are absolute or caller-cwd-relative folders containing SUBAGENTS.md; direct access is allowed only when the user explicitly authorizes it for the current request; recursive locational delegation to the current source root or active source stack is blocked.",
			"Behavioral-agent child sessions do not advertise locational agents by default; set includeSourceAgents true when a behavioral agent should orchestrate locational agents.",
			'Default behavioral agent scope is "user" (from ~/.pi/agent/agents).',
			'To enable project-local behavioral agents in .pi/agents, set agentScope: "both" (or "project").',
		].join(" "),
		parameters: SubagentParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "user";
			const includeSourceAgents = params.includeSourceAgents ?? false;
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;
			const confirmProjectAgents = params.confirmProjectAgents ?? true;

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const singleId = getAgentId(params);
			const hasSingle = Boolean(singleId && params.task);
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

			const makeDetails =
				(mode: "single" | "parallel" | "chain") =>
				(results: SingleResult[]): SubagentDetails => ({
					mode,
					agentScope,
					includeSourceAgents,
					projectAgentsDir: discovery.projectAgentsDir,
					sourceAgents: discovery.sourceAgents.map((agent) => agent.id),
					results,
				});

			if (modeCount !== 1) {
				const available = agents.map((a) => `${a.id} (${a.source})`).join(", ") || "none";
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

			const mode = hasChain ? "chain" : hasTasks ? "parallel" : "single";
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
					: [{ id: singleId, session: params.session, task: params.task ?? "" }];
			for (const requested of requestedDelegations) {
				if (!requested.id) continue;
				const agent = resolveAgent(ctx.cwd, agents, requested.id);
				if (!agent) continue;
				const sourceLoopError = getSourceLoopError(agent);
				if (sourceLoopError) {
					const result = makeErrorResult(agent.id, requested.task, sourceLoopError, requested.step, requested.session);
					return {
						content: [{ type: "text", text: sourceLoopError }],
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
					.filter((a): a is AgentConfig => a?.source === "project");

				if (projectAgentsRequested.length > 0) {
					const names = projectAgentsRequested.map((a) => a.id).join(", ");
					const dir = discovery.projectAgentsDir ?? "(unknown)";
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${names}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok)
						return {
							content: [{ type: "text", text: "Canceled: project-local agents not approved." }],
							details: makeDetails(hasChain ? "chain" : hasTasks ? "parallel" : "single")([]),
						};
				}
			}

			if (params.chain && params.chain.length > 0) {
				const results: SingleResult[] = [];
				let previousOutput = "";

				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					const stepId = getAgentId(step);
					if (!stepId) {
						return {
							content: [{ type: "text", text: `Chain stopped at step ${i + 1}: missing subagent id.` }],
							details: makeDetails("chain")(results),
							isError: true,
						};
					}
					const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);

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
						step.session,
						taskWithContext,
						step.cwd,
						i + 1,
						signal,
						chainUpdate,
						makeDetails("chain"),
						includeSourceAgents,
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
						agentSource: "unknown",
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
					if (!taskId) return makeErrorResult("(missing id)", t.task, "Missing subagent id.", undefined, t.session);
					const result = await runDelegation(
						pi,
						ctx,
						ctx.cwd,
						agents,
						taskId,
						t.session,
						t.task,
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
						includeSourceAgents,
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
					params.task,
					params.cwd,
					undefined,
					signal,
					onUpdate,
					makeDetails("single"),
					includeSourceAgents,
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

			const available = agents.map((a) => `${a.id} (${a.source})`).join(", ") || "none";
			return {
				content: [{ type: "text", text: `Invalid parameters. Available agents: ${available}` }],
				details: makeDetails("single")([]),
			};
		},

		renderCall: renderSubagentCall,
		renderResult: renderSubagentResult,
	});
}
