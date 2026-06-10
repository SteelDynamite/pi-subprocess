import * as os from "node:os";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { COLLAPSED_ITEM_COUNT, MAX_NESTED_RENDER_DEPTH, MAX_NESTED_RENDER_LINES } from "./constants.ts";
import { getAgentId } from "./params.ts";
import { formatUsageStats, getDisplayItems, getFinalOutput, getNestedSubprocessIds, isFailedResult } from "./result.ts";
import type { AgentScope } from "./agents.ts";
import type { DisplayItem, NestedSubprocessCall, SessionIntent, SingleResult, SubprocessDetails } from "./types.ts";

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

export function renderSubprocessCall(args: any, theme: any, _context: any) {
			const scope: AgentScope = args.agentScope ?? "user";
			const formatCallSession = (session?: SessionIntent) => session ? theme.fg("muted", ` [session:${session}]`) : "";
			if (args.chain && args.chain.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subprocess ")) +
					theme.fg("accent", `chain (${args.chain.length} steps)`) +
					theme.fg("muted", ` [${scope}]`);
				for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
					const step = args.chain[i];
					const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
					const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
					text +=
						"\n  " +
						theme.fg("muted", `${i + 1}.`) +
						" " +
						theme.fg("accent", getAgentId(step) ?? "...") +
						formatCallSession(step.session) +
						theme.fg("dim", ` ${preview}`);
				}
				if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			if (args.tasks && args.tasks.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subprocess ")) +
					theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
					theme.fg("muted", ` [${scope}]`);
				for (const t of args.tasks.slice(0, 3)) {
					const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
					text += `\n  ${theme.fg("accent", getAgentId(t) ?? "...")}${formatCallSession(t.session)}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			if (args.commands && args.commands.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("subprocess ")) +
					theme.fg("accent", `commands (${args.commands.length} tasks)`);
				for (const commandTask of args.commands.slice(0, 3)) {
					const command = commandTask.command || "...";
					const preview = command.length > 50 ? `${command.slice(0, 50)}...` : command;
					text += `\n  ${theme.fg("accent", commandTask.name || "command")}${theme.fg("dim", ` $ ${preview}`)}`;
				}
				if (args.commands.length > 3) text += `\n  ${theme.fg("muted", `... +${args.commands.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			const agentName = getAgentId(args) || "...";
			const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
			let text =
				theme.fg("toolTitle", theme.bold("subprocess ")) +
				theme.fg("accent", agentName) +
				formatCallSession(args.session) +
				theme.fg("muted", ` [${scope}]`);
			text += `\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		}

function previewLine(text: string, max = 120): string {
	const singleLine = text.replace(/\s+/g, " ").trim();
	return singleLine.length > max ? `${singleLine.slice(0, max)}...` : singleLine;
}

function formatNestedResultLine(result: SingleResult, themeFg: (color: any, text: string) => string): string {
	const icon = result.exitCode === -1 ? themeFg("warning", "⏳") : isFailedResult(result) ? themeFg("error", "✗") : themeFg("success", "✓");
	let line = `${icon} ${themeFg("accent", result.agent)}`;
	if (result.step !== undefined) line += themeFg("muted", ` [step:${result.step}]`);
	if (result.kind === "command") line += themeFg("muted", " [command]");
	if (result.exitCode === -1) return `${line} ${themeFg("muted", "running")}`;
	if (result.stopReason && result.stopReason !== "end") line += ` ${themeFg("error", `[${result.stopReason}]`)}`;
	const output = result.kind === "command" ? result.stdout || result.stderr || result.errorMessage || "" : getFinalOutput(result.messages) || result.errorMessage || result.stderr || "";
	const preview = previewLine(output);
	return preview ? `${line} ${themeFg("dim", preview)}` : line;
}

export function formatNestedSubprocessesForDisplay(
	nestedSubprocesses: NestedSubprocessCall[] | undefined,
	themeFg: (color: any, text: string) => string = (_color, text) => text,
	depth = 0,
): string {
	if (!nestedSubprocesses || nestedSubprocesses.length === 0) return "";
	const lines: string[] = [];
	const append = (line: string) => {
		if (lines.length < MAX_NESTED_RENDER_LINES) lines.push(line);
	};
	const formatCalls = (calls: NestedSubprocessCall[], currentDepth: number) => {
		const indent = "  ".repeat(currentDepth);
		if (currentDepth >= MAX_NESTED_RENDER_DEPTH) {
			append(`${indent}${themeFg("muted", "↳ ... nested subprocess depth cap")}`);
			return;
		}
		for (const call of calls) {
			if (lines.length >= MAX_NESTED_RENDER_LINES) break;
			const statusIcon = call.status === "running" ? themeFg("warning", "⏳") : call.status === "failed" ? themeFg("error", "✗") : themeFg("success", "✓");
			const shortId = call.toolCallId.length > 10 ? `${call.toolCallId.slice(0, 10)}…` : call.toolCallId;
			let header = `${indent}${themeFg("muted", "↳")} ${statusIcon} ${themeFg("toolTitle", call.toolName)} ${themeFg("muted", `[${shortId}] ${call.status}`)}`;
			if (call.truncated) header += themeFg("warning", " [truncated]");
			append(header);
			if (call.error) append(`${indent}  ${themeFg("error", `Error: ${previewLine(call.error)}`)}`);
			const details = call.details;
			if (!details) {
				if (call.status === "running") append(`${indent}  ${themeFg("muted", "(waiting for nested details...)")}`);
				continue;
			}
			append(`${indent}  ${themeFg("muted", `${details.mode}: ${details.results.length} result${details.results.length === 1 ? "" : "s"}`)}`);
			for (const result of details.results.slice(0, 6)) {
				append(`${indent}  ${formatNestedResultLine(result, themeFg)}`);
				if (result.nestedSubprocesses?.length) formatCalls(result.nestedSubprocesses, currentDepth + 1);
			}
			if (details.results.length > 6) append(`${indent}  ${themeFg("muted", `... +${details.results.length - 6} more nested results`)}`);
		}
	};
	formatCalls(nestedSubprocesses, depth);
	if (lines.length >= MAX_NESTED_RENDER_LINES) lines.push(themeFg("muted", "... nested subprocess render cap"));
	return lines.join("\n");
}

export function renderSubprocessResult(result: any, { expanded }: { expanded: boolean }, theme: any, _context: any) {
			const details = result.details as SubprocessDetails | undefined;
			const formatResultSession = (r: SingleResult) => r.sessionIntent ? theme.fg("muted", ` [session:${r.sessionIntent}]`) : "";
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();

			const renderDisplayItems = (items: DisplayItem[], limit?: number) => {
				const toShow = limit ? items.slice(-limit) : items;
				const skipped = limit && items.length > limit ? items.length - limit : 0;
				let text = "";
				if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
				for (const item of toShow) {
					if (item.type === "text") {
						const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
						text += `${theme.fg("toolOutput", preview)}\n`;
					} else {
						text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
					}
				}
				return text.trimEnd();
			};

			const renderWrongSessionIntent = (r: SingleResult) => {
				const wrong = r.wrongSessionIntent;
				if (!wrong) return undefined;
				return [
					"Wrong session intent",
					`Agent: ${wrong.agentId}`,
					`Requested: session:${wrong.requested}`,
					`Required: session:${wrong.required}`,
					`Retry: ${wrong.recommendedRetry}`,
				].join("\n");
			};

			if (details.mode === "single" && details.results.length === 1) {
				const r = details.results[0];
				const isError = isFailedResult(r);
				const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
				const displayItems = getDisplayItems(r.messages);
				const finalOutput = getFinalOutput(r.messages);

				if (expanded) {
					const container = new Container();
					let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentOrigin})`)}${formatResultSession(r)}`;
					if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
					container.addChild(new Text(header, 0, 0));
					const nestedIds = getNestedSubprocessIds(r.messages);
					if (nestedIds.length > 0)
						container.addChild(new Text(theme.fg("dim", `Nested: ${nestedIds.map((id) => `${r.agent} > ${id}`).join(", ")}`), 0, 0));
					const nestedText = formatNestedSubprocessesForDisplay(r.nestedSubprocesses, theme.fg.bind(theme));
					if (nestedText) container.addChild(new Text(nestedText, 0, 0));
					if (r.warning) container.addChild(new Text(theme.fg("warning", `Warning: ${r.warning}`), 0, 0));
					const wrongSessionText = renderWrongSessionIntent(r);
					if (wrongSessionText) container.addChild(new Text(theme.fg("error", wrongSessionText), 0, 0));
					else if (isError && r.errorMessage)
						container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
					container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
					if (displayItems.length === 0 && !finalOutput) {
						container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
					} else {
						for (const item of displayItems) {
							if (item.type === "toolCall")
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
						}
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}
					}
					const usageStr = formatUsageStats(r.usage, r.model);
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
					}
					return container;
				}

				const nestedIds = getNestedSubprocessIds(r.messages);
				let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentOrigin})`)}${formatResultSession(r)}`;
				if (nestedIds.length > 0) text += theme.fg("dim", ` +${nestedIds.length} nested`);
				const nestedText = formatNestedSubprocessesForDisplay(r.nestedSubprocesses, theme.fg.bind(theme));
				if (nestedText) text += `\n${nestedText}`;
				if (isError && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
				if (r.warning) text += `\n${theme.fg("warning", `Warning: ${r.warning}`)}`;
				const wrongSessionText = renderWrongSessionIntent(r);
				if (wrongSessionText) text += `\n${theme.fg("error", wrongSessionText)}`;
				else if (isError && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
				else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
				else {
					text += `\n${renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)}`;
					if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				}
				const usageStr = formatUsageStats(r.usage, r.model);
				if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
				return new Text(text, 0, 0);
			}

			const aggregateUsage = (results: SingleResult[]) => {
				const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
				for (const r of results) {
					total.input += r.usage.input;
					total.output += r.usage.output;
					total.cacheRead += r.usage.cacheRead;
					total.cacheWrite += r.usage.cacheWrite;
					total.cost += r.usage.cost;
					total.turns += r.usage.turns;
				}
				return total;
			};

			if (details.mode === "chain") {
				const successCount = details.results.filter((r) => r.exitCode === 0).length;
				const icon = successCount === details.results.length ? theme.fg("success", "✓") : theme.fg("error", "✗");

				if (expanded) {
					const container = new Container();
					container.addChild(
						new Text(
							icon +
								" " +
								theme.fg("toolTitle", theme.bold("chain ")) +
								theme.fg("accent", `${successCount}/${details.results.length} steps`),
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(
								`${theme.fg("muted", `─── Step ${r.step}: `) + theme.fg("accent", r.agent)}${formatResultSession(r)} ${rIcon}`,
								0,
								0,
							),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));
						const wrongSessionText = renderWrongSessionIntent(r);
						if (wrongSessionText) container.addChild(new Text(theme.fg("error", wrongSessionText), 0, 0));
						const nestedText = formatNestedSubprocessesForDisplay(r.nestedSubprocesses, theme.fg.bind(theme));
						if (nestedText) container.addChild(new Text(nestedText, 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const stepUsage = formatUsageStats(r.usage, r.model);
						if (stepUsage) container.addChild(new Text(theme.fg("dim", stepUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view
				let text =
					icon +
					" " +
					theme.fg("toolTitle", theme.bold("chain ")) +
					theme.fg("accent", `${successCount}/${details.results.length} steps`);
				for (const r of details.results) {
					const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.agent)}${formatResultSession(r)} ${rIcon}`;
					const wrongSessionText = renderWrongSessionIntent(r);
					const nestedText = formatNestedSubprocessesForDisplay(r.nestedSubprocesses, theme.fg.bind(theme));
					if (nestedText) text += `\n${nestedText}`;
					if (wrongSessionText) text += `\n${theme.fg("error", wrongSessionText)}`;
					else if (displayItems.length === 0) text += `\n${theme.fg("muted", "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				const usageStr = formatUsageStats(aggregateUsage(details.results));
				if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			if (details.mode === "parallel") {
				const running = details.results.filter((r) => r.exitCode === -1).length;
				const successCount = details.results.filter((r) => r.exitCode !== -1 && !isFailedResult(r)).length;
				const failCount = details.results.filter((r) => r.exitCode !== -1 && isFailedResult(r)).length;
				const isRunning = running > 0;
				const icon = isRunning
					? theme.fg("warning", "⏳")
					: failCount > 0
						? theme.fg("warning", "◐")
						: theme.fg("success", "✓");
				const status = isRunning
					? `${successCount + failCount}/${details.results.length} done, ${running} running`
					: `${successCount}/${details.results.length} tasks`;

				if (expanded && !isRunning) {
					const container = new Container();
					container.addChild(
						new Text(
							`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`,
							0,
							0,
						),
					);

					for (const r of details.results) {
						const rIcon = isFailedResult(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");
						const displayItems = getDisplayItems(r.messages);
						const finalOutput = getFinalOutput(r.messages);

						container.addChild(new Spacer(1));
						container.addChild(
							new Text(`${theme.fg("muted", "─── ") + theme.fg("accent", r.agent)}${formatResultSession(r)} ${rIcon}`, 0, 0),
						);
						container.addChild(new Text(theme.fg("muted", "Task: ") + theme.fg("dim", r.task), 0, 0));
						const wrongSessionText = renderWrongSessionIntent(r);
						if (wrongSessionText) container.addChild(new Text(theme.fg("error", wrongSessionText), 0, 0));
						const nestedText = formatNestedSubprocessesForDisplay(r.nestedSubprocesses, theme.fg.bind(theme));
						if (nestedText) container.addChild(new Text(nestedText, 0, 0));

						// Show tool calls
						for (const item of displayItems) {
							if (item.type === "toolCall") {
								container.addChild(
									new Text(
										theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
										0,
										0,
									),
								);
							}
						}

						// Show final output as markdown
						if (finalOutput) {
							container.addChild(new Spacer(1));
							container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
						}

						const taskUsage = formatUsageStats(r.usage, r.model);
						if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
					}

					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) {
						container.addChild(new Spacer(1));
						container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
					}
					return container;
				}

				// Collapsed view (or still running)
				let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
				for (const r of details.results) {
					const rIcon =
						r.exitCode === -1
							? theme.fg("warning", "⏳")
							: isFailedResult(r)
								? theme.fg("error", "✗")
								: theme.fg("success", "✓");
					const displayItems = getDisplayItems(r.messages);
					text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.agent)}${formatResultSession(r)} ${rIcon}`;
					const wrongSessionText = renderWrongSessionIntent(r);
					const nestedText = formatNestedSubprocessesForDisplay(r.nestedSubprocesses, theme.fg.bind(theme));
					if (nestedText) text += `\n${nestedText}`;
					if (wrongSessionText) text += `\n${theme.fg("error", wrongSessionText)}`;
					else if (displayItems.length === 0)
						text += `\n${theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)")}`;
					else text += `\n${renderDisplayItems(displayItems, 5)}`;
				}
				if (!isRunning) {
					const usageStr = formatUsageStats(aggregateUsage(details.results));
					if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
				}
				if (!expanded) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
				return new Text(text, 0, 0);
			}

			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
		}

