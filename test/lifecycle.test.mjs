import assert from "node:assert/strict";
import { test } from "node:test";
import {
	createSubprocessLifecycle,
	getSubprocessLifecycleSnapshot,
	markSubprocessActivity,
	markSubprocessClosed,
	markSubprocessTerminating,
	recordSubprocessError,
} from "../lifecycle.ts";

test("subprocess lifecycle tracks phase, activity, and final snapshot", () => {
	const state = createSubprocessLifecycle("command", "sample", { timeoutMs: 1000, now: 10 });
	assert.equal(state.phase, "starting");
	assert.equal(getSubprocessLifecycleSnapshot(state, 15).exitCode, -1);

	markSubprocessActivity(state, 20);
	assert.equal(state.phase, "running");
	assert.equal(state.lastActivityAt, 20);

	assert.equal(markSubprocessTerminating(state, "timeout", { timedOut: true, now: 30 }), true);
	assert.equal(markSubprocessTerminating(state, "aborted", { now: 35 }), false);
	markSubprocessClosed(state, 124, 40);

	assert.deepEqual(getSubprocessLifecycleSnapshot(state, 50), {
		phase: "closed",
		exitCode: 124,
		durationMs: 30,
		lastActivityAt: 40,
		stopReason: "timeout",
		timedOut: true,
		errorMessage: undefined,
	});
});

test("subprocess lifecycle records errors before close", () => {
	const state = createSubprocessLifecycle("agent", "agent", { now: 1 });
	recordSubprocessError(state, "boom", 2);
	markSubprocessClosed(state, 1, 3);
	const snapshot = getSubprocessLifecycleSnapshot(state, 4);
	assert.equal(snapshot.stopReason, "error");
	assert.equal(snapshot.errorMessage, "boom");
	assert.equal(snapshot.exitCode, 1);
});
