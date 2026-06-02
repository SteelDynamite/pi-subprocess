import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import {
	formatWrongIntentReason,
	getRequiredSessionIntent,
	restoreSubagentState,
	setContextThreshold,
	subagentSettings,
	trackedSessions,
	updateTrackedSession,
} from "../state.ts";

function ctx(sessionKey = "session-1", branch = []) {
	return {
		cwd: "/tmp/project",
		sessionManager: {
			getSessionFile: () => sessionKey,
			getBranch: () => branch,
		},
	};
}

function agent(overrides = {}) {
	return {
		id: "agent-a",
		resumable: true,
		kind: "behavior",
		source: "user",
		rootDir: "/tmp/agent-a",
		filePath: "/tmp/agent-a/SUBAGENTS.md",
		description: "",
		manifest: true,
		systemPrompt: "",
		...overrides,
	};
}

function result(overrides = {}) {
	return {
		agent: "agent-a",
		agentSource: "user",
		task: "task",
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 20, turns: 1 },
		contextWindow: 100,
		...overrides,
	};
}

function resetState() {
	trackedSessions.clear();
	subagentSettings.reuseEnabled = true;
	setContextThreshold(0.6);
}

afterEach(resetState);

test("getRequiredSessionIntent returns new for non-resumable, disabled reuse, or no record", () => {
	resetState();
	assert.deepEqual(getRequiredSessionIntent(ctx(), agent({ resumable: false })), { intent: "new", reason: "non-resumable" });
	subagentSettings.reuseEnabled = false;
	assert.deepEqual(getRequiredSessionIntent(ctx(), agent()), { intent: "new", reason: "reuse-disabled" });
	subagentSettings.reuseEnabled = true;
	assert.deepEqual(getRequiredSessionIntent(ctx(), agent()), { intent: "new", reason: "none" });
});

test("updateTrackedSession sets next intent resume under threshold and new over threshold", () => {
	resetState();
	const c = ctx();
	const a = agent();
	const under = result({ usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 20, turns: 1 } });
	updateTrackedSession(c, a, "child-session", under);
	assert.equal(under.nextSessionIntent, "resume");
	assert.equal(getRequiredSessionIntent(c, a).intent, "resume");

	const over = result({ usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 80, turns: 1 } });
	updateTrackedSession(c, a, "child-session-2", over);
	assert.equal(over.nextSessionIntent, "new");
	assert.equal(getRequiredSessionIntent(c, a).reason, "over-threshold");
});

test("updateTrackedSession marks failed or missing-session resumable calls as new without tracking", () => {
	resetState();
	const failed = result({ exitCode: 1 });
	updateTrackedSession(ctx(), agent(), "child-session", failed);
	assert.equal(failed.nextSessionIntent, "new");

	const missingSession = result();
	updateTrackedSession(ctx(), agent(), undefined, missingSession);
	assert.equal(missingSession.nextSessionIntent, "new");
});

test("restoreSubagentState uses latest custom state entry", () => {
	resetState();
	const branch = [
		{ type: "custom", customType: "subagent-state", data: { settings: { reuseEnabled: false, contextThreshold: 0.5 }, sessions: [] } },
		{
			type: "custom",
			customType: "subagent-state",
			data: {
				settings: { reuseEnabled: true, contextThreshold: 0.8 },
				sessions: [{ mainSessionKey: "session-2", agentId: "agent-a", sessionId: "child", nextIntent: "resume", reason: "under-threshold", contextTokens: 10, updatedAt: 1 }],
			},
		},
	];
	restoreSubagentState(ctx("session-2", branch));
	assert.equal(subagentSettings.contextThreshold, 0.8);
	assert.equal(getRequiredSessionIntent(ctx("session-2"), agent()).intent, "resume");
});

test("formatWrongIntentReason explains major reasons", () => {
	assert.match(formatWrongIntentReason(agent({ resumable: false }), "resume", "new", "non-resumable"), /not resumable/);
	assert.match(formatWrongIntentReason(agent(), "resume", "new", "over-threshold"), /over the context limit/);
	assert.match(formatWrongIntentReason(agent(), "resume", "new", "none"), /no prior reusable session/);
});
