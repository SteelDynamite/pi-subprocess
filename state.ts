import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "./pi-compat.ts";
import type { AgentConfig } from "./agents.ts";
import { DEFAULT_CONTEXT_THRESHOLD, SUBPROCESS_STATE_ENTRY } from "./constants.ts";
import { isFailedResult } from "./result.ts";
import type { NextIntentReason, PersistedSubprocessState, SessionIntent, SingleResult, SubprocessSettings, TrackedSession } from "./types.ts";

export let subprocessSettings: SubprocessSettings = { reuseEnabled: true, contextThreshold: DEFAULT_CONTEXT_THRESHOLD };
export const trackedSessions = new Map<string, TrackedSession>();

export function getMainSessionKey(ctx: ExtensionContext): string {
	const manager = ctx.sessionManager as any;
	return manager.getSessionFile?.() ?? manager.getSessionId?.() ?? `memory:${path.resolve(ctx.cwd)}`;
}

function getSessionRecordKey(ctx: ExtensionContext, agentId: string): string {
	return `${getMainSessionKey(ctx)}\0${agentId}`;
}

export function restoreSubprocessState(ctx: ExtensionContext) {
	const branchEntries = ctx.sessionManager.getBranch();
	let latest: PersistedSubprocessState | undefined;
	for (const entry of branchEntries) {
		if (entry.type === "custom" && entry.customType === SUBPROCESS_STATE_ENTRY) {
			latest = entry.data as PersistedSubprocessState | undefined;
		}
	}
	if (!latest) return;
	subprocessSettings = {
		reuseEnabled: latest.settings?.reuseEnabled ?? true,
		contextThreshold: latest.settings?.contextThreshold ?? DEFAULT_CONTEXT_THRESHOLD,
	};
	trackedSessions.clear();
	for (const record of latest.sessions ?? []) {
		trackedSessions.set(`${record.mainSessionKey}\0${record.agentId}`, record);
	}
}

export function persistSubprocessState(pi: ExtensionAPI) {
	pi.appendEntry<PersistedSubprocessState>(SUBPROCESS_STATE_ENTRY, {
		settings: subprocessSettings,
		sessions: Array.from(trackedSessions.values()),
	});
}

export function toggleReuse() {
	subprocessSettings.reuseEnabled = !subprocessSettings.reuseEnabled;
}

export function setContextThreshold(value: number) {
	subprocessSettings.contextThreshold = value;
}

export function getRequiredSessionIntent(ctx: ExtensionContext, agent: AgentConfig): { intent: SessionIntent; reason: NextIntentReason; record?: TrackedSession } {
	if (!agent.resumable) return { intent: "new", reason: "non-resumable" };
	if (!subprocessSettings.reuseEnabled) return { intent: "new", reason: "reuse-disabled" };
	const record = trackedSessions.get(getSessionRecordKey(ctx, agent.id));
	if (!record) return { intent: "new", reason: "none" };
	return { intent: record.nextIntent, reason: record.reason, record };
}

export function getWrongIntentRetry(required: SessionIntent, reason: NextIntentReason): string {
	return reason === "over-threshold"
		? `Retry with session: "${required}" and craft a fresh-session task prompt.`
		: `Retry with session: "${required}".`;
}

export function formatWrongIntentReason(agent: AgentConfig, requested: SessionIntent, required: SessionIntent, reason: NextIntentReason): string {
	const retry = getWrongIntentRetry(required, reason);
	if (!agent.resumable) return `Wrong session intent for "${agent.id}": requested "${requested}", required "new" because this subprocess agent is not resumable. ${retry}`;
	if (reason === "reuse-disabled") return `Wrong session intent for "${agent.id}": requested "${requested}", required "new" because resumable session reuse is disabled. ${retry}`;
	if (reason === "over-threshold") return `Wrong session intent for "${agent.id}": requested "${requested}", required "new" because the locational session is over the context limit. ${retry}`;
	if (reason === "none") return `Wrong session intent for "${agent.id}": requested "${requested}", required "new" because no prior reusable session exists. ${retry}`;
	return `Wrong session intent for "${agent.id}": requested "${requested}", required "${required}". ${retry}`;
}

export function updateTrackedSession(ctx: ExtensionContext, agent: AgentConfig, sessionId: string | undefined, result: SingleResult) {
	if (!agent.resumable) return;
	if (!subprocessSettings.reuseEnabled || !sessionId || isFailedResult(result)) {
		result.nextSessionIntent = "new";
		return;
	}
	const contextTokens = result.usage.contextTokens;
	const contextWindow = result.contextWindow;
	const overThreshold = Boolean(contextWindow && contextTokens > 0 && contextTokens / contextWindow >= subprocessSettings.contextThreshold);
	const record: TrackedSession = {
		mainSessionKey: getMainSessionKey(ctx),
		agentId: agent.id,
		sessionId,
		nextIntent: overThreshold ? "new" : "resume",
		reason: overThreshold ? "over-threshold" : "under-threshold",
		contextTokens,
		contextWindow,
		updatedAt: Date.now(),
	};
	trackedSessions.set(getSessionRecordKey(ctx, agent.id), record);
	result.nextSessionIntent = record.nextIntent;
}
