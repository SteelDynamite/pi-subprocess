import { spawn, type ChildProcess } from "node:child_process";
import * as path from "node:path";
import { DEFAULT_COMMAND_TIMEOUT_MS, PER_TASK_OUTPUT_CAP } from "./constants.ts";
import { formatCommandResultOutput } from "./result.ts";
import type { OnCommandUpdateCallback, SingleResult } from "./types.ts";

export interface CommandTaskInput {
	name?: string;
	command: string;
	cwd?: string;
	timeoutMs?: number;
	maxOutputBytes?: number;
}

function resolveCommandCwd(defaultCwd: string, cwd: string | undefined): string {
	return cwd ? path.resolve(defaultCwd, cwd) : defaultCwd;
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
	if (!Number.isFinite(value) || value === undefined) return fallback;
	return Math.max(1, Math.floor(value));
}

function killCommandProcess(proc: ChildProcess, signal: NodeJS.Signals) {
	if (process.platform !== "win32" && proc.pid) {
		try {
			process.kill(-proc.pid, signal);
			return;
		} catch {
			// Fall back to signaling the direct child.
		}
	}
	try {
		proc.kill(signal);
	} catch {
		// Already exited.
	}
}

function appendCapped(current: string, chunk: string, maxBytes: number): { text: string; truncated: boolean; bytes: number } {
	const next = current + chunk;
	const bytes = Buffer.byteLength(next, "utf8");
	if (bytes <= maxBytes) return { text: next, truncated: false, bytes };

	let truncated = next.slice(0, maxBytes);
	while (Buffer.byteLength(truncated, "utf8") > maxBytes) truncated = truncated.slice(0, -1);
	return { text: truncated, truncated: true, bytes };
}

function makeCommandMessage(result: SingleResult): any {
	return {
		role: "assistant",
		content: [{ type: "text", text: formatCommandResultOutput(result) }],
	};
}

export async function runCommandTask(
	defaultCwd: string,
	input: CommandTaskInput,
	step: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnCommandUpdateCallback | undefined,
): Promise<SingleResult> {
	const startedAt = Date.now();
	const cwd = resolveCommandCwd(defaultCwd, input.cwd);
	const maxOutputBytes = normalizePositiveInteger(input.maxOutputBytes, PER_TASK_OUTPUT_CAP);
	const timeoutMs = normalizePositiveInteger(input.timeoutMs, DEFAULT_COMMAND_TIMEOUT_MS);
	const label = input.name?.trim() || input.command;
	const result: SingleResult = {
		kind: "command",
		agent: label,
		agentOrigin: "unknown",
		task: input.command,
		command: input.command,
		exitCode: -1,
		messages: [],
		stdout: "",
		stderr: "",
		stdoutBytes: 0,
		stderrBytes: 0,
		stdoutTruncated: false,
		stderrTruncated: false,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		step,
		cwd,
		durationMs: 0,
		timeoutMs,
	};

	const updateMessage = () => {
		result.durationMs = Date.now() - startedAt;
		result.messages = [makeCommandMessage(result)];
		onUpdate?.(result);
	};

	updateMessage();

	let timeout: NodeJS.Timeout | undefined;
	let sigkillTimeout: NodeJS.Timeout | undefined;
	let wasAborted = false;
	let terminating = false;

	const exitCode = await new Promise<number>((resolve) => {
		const proc = spawn(input.command, {
			cwd,
			env: process.env,
			shell: true,
			detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "pipe"],
		});

		const terminate = (timedOut: boolean) => {
			if (result.exitCode !== -1 || terminating) return;
			terminating = true;
			wasAborted = !timedOut;
			result.timedOut = timedOut;
			result.stopReason = timedOut ? "timeout" : "aborted";
			killCommandProcess(proc, "SIGTERM");
			sigkillTimeout = setTimeout(() => killCommandProcess(proc, "SIGKILL"), 5000);
			updateMessage();
		};

		proc.stdout.on("data", (data) => {
			const next = appendCapped(result.stdout ?? "", data.toString(), maxOutputBytes);
			result.stdout = next.text;
			result.stdoutTruncated = Boolean(result.stdoutTruncated || next.truncated);
			result.stdoutBytes = next.bytes;
			updateMessage();
		});

		proc.stderr.on("data", (data) => {
			const next = appendCapped(result.stderr, data.toString(), maxOutputBytes);
			result.stderr = next.text;
			result.stderrTruncated = Boolean(result.stderrTruncated || next.truncated);
			result.stderrBytes = next.bytes;
			updateMessage();
		});

		proc.on("close", (code) => {
			if (timeout) clearTimeout(timeout);
			if (sigkillTimeout) clearTimeout(sigkillTimeout);
			resolve(code ?? (result.timedOut ? 124 : 1));
		});

		proc.on("error", (error) => {
			result.errorMessage = error.message;
			resolve(1);
		});

		timeout = setTimeout(() => terminate(true), timeoutMs);
		if (signal) {
			if (signal.aborted) terminate(false);
			else signal.addEventListener("abort", () => terminate(false), { once: true });
		}
	});

	result.exitCode = exitCode;
	result.durationMs = Date.now() - startedAt;
	if (result.timedOut && !result.stderr.includes("Command timed out")) {
		const next = appendCapped(result.stderr, `${result.stderr ? "\n" : ""}Command timed out after ${timeoutMs}ms.`, maxOutputBytes);
		result.stderr = next.text;
		result.stderrTruncated = Boolean(result.stderrTruncated || next.truncated);
		result.stderrBytes = next.bytes;
	}
	if (wasAborted && !result.timedOut) result.stopReason = "aborted";
	result.messages = [makeCommandMessage(result)];
	onUpdate?.(result);
	return result;
}
