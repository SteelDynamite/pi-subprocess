export type SubprocessLifecycleKind = "agent" | "command";
export type SubprocessLifecyclePhase = "starting" | "running" | "terminating" | "closed";
export type SubprocessStopReason = "aborted" | "timeout" | "error";

export interface SubprocessLifecycleState {
	kind: SubprocessLifecycleKind;
	id: string;
	phase: SubprocessLifecyclePhase;
	startedAt: number;
	lastActivityAt: number;
	terminatedAt?: number;
	exitCode?: number;
	stopReason?: SubprocessStopReason | string;
	timedOut?: boolean;
	errorMessage?: string;
	timeoutMs?: number;
}

export interface SubprocessLifecycleSnapshot {
	phase: SubprocessLifecyclePhase;
	exitCode: number;
	durationMs: number;
	lastActivityAt: number;
	stopReason?: string;
	timedOut?: boolean;
	errorMessage?: string;
}

export function createSubprocessLifecycle(
	kind: SubprocessLifecycleKind,
	id: string,
	options: { timeoutMs?: number; now?: number } = {},
): SubprocessLifecycleState {
	const now = options.now ?? Date.now();
	return {
		kind,
		id,
		phase: "starting",
		startedAt: now,
		lastActivityAt: now,
		timeoutMs: options.timeoutMs,
	};
}

export function markSubprocessActivity(state: SubprocessLifecycleState, now = Date.now()): void {
	if (state.phase === "closed") return;
	state.lastActivityAt = now;
	if (state.phase === "starting") state.phase = "running";
}

export function markSubprocessTerminating(
	state: SubprocessLifecycleState,
	reason: SubprocessStopReason,
	options: { timedOut?: boolean; now?: number } = {},
): boolean {
	if (state.phase === "closed" || state.phase === "terminating") return false;
	const now = options.now ?? Date.now();
	state.phase = "terminating";
	state.lastActivityAt = now;
	state.stopReason = reason;
	if (options.timedOut !== undefined) state.timedOut = options.timedOut;
	return true;
}

export function recordSubprocessError(state: SubprocessLifecycleState, message: string, now = Date.now()): void {
	if (state.phase === "closed") return;
	state.errorMessage = message;
	state.stopReason = "error";
	state.lastActivityAt = now;
}

export function markSubprocessClosed(state: SubprocessLifecycleState, exitCode: number, now = Date.now()): void {
	if (state.phase === "closed") return;
	state.phase = "closed";
	state.exitCode = exitCode;
	state.terminatedAt = now;
	state.lastActivityAt = now;
}

export function getSubprocessLifecycleSnapshot(
	state: SubprocessLifecycleState,
	now = Date.now(),
): SubprocessLifecycleSnapshot {
	const end = state.terminatedAt ?? now;
	return {
		phase: state.phase,
		exitCode: state.exitCode ?? -1,
		durationMs: Math.max(0, end - state.startedAt),
		lastActivityAt: state.lastActivityAt,
		stopReason: state.stopReason,
		timedOut: state.timedOut,
		errorMessage: state.errorMessage,
	};
}
