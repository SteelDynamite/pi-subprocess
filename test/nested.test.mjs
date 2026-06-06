import assert from "node:assert/strict";
import { test } from "node:test";
import { processChildJsonEvent } from "../execution.ts";
import { applyNestedSubprocessEvent } from "../nested.ts";
import { formatNestedSubprocessesForDisplay } from "../render.ts";

const usage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 });

function result(overrides = {}) {
	return {
		agent: "owner",
		agentOrigin: "user",
		task: "owning task",
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: usage(),
		...overrides,
	};
}

function details(results, mode = "single") {
	return {
		mode,
		agentScope: "user",
		includeLocationalAgents: false,
		projectAgentsDir: null,
		locationalAgents: [],
		results,
	};
}

function assistantText(text) {
	return { role: "assistant", content: [{ type: "text", text }] };
}

test("processChildJsonEvent tracks nested subprocess start/update/end by toolCallId", () => {
	const owner = result();
	let updates = 0;
	const emitUpdate = () => updates++;

	processChildJsonEvent({ type: "tool_execution_start", toolCallId: "call-1", toolName: "subprocess", args: {} }, owner, emitUpdate);
	assert.equal(owner.nestedSubprocesses.length, 1);
	assert.equal(owner.nestedSubprocesses[0].status, "running");

	processChildJsonEvent(
		{
			type: "tool_execution_update",
			toolCallId: "call-1",
			toolName: "subprocess",
			partialResult: { details: details([result({ agent: "nested-a", exitCode: -1 })]) },
		},
		owner,
		emitUpdate,
	);
	assert.equal(owner.nestedSubprocesses[0].details.results[0].agent, "nested-a");
	assert.equal(owner.nestedSubprocesses[0].details.results[0].exitCode, -1);

	processChildJsonEvent(
		{
			type: "tool_execution_end",
			toolCallId: "call-1",
			toolName: "subprocess",
			result: { details: details([result({ agent: "nested-a", messages: [assistantText("done")] })]) },
			isError: false,
		},
		owner,
		emitUpdate,
	);
	assert.equal(owner.nestedSubprocesses[0].status, "completed");
	assert.equal(owner.nestedSubprocesses[0].details.results[0].messages[0].content[0].text, "done");
	assert.equal(updates, 3);
});

test("interleaved nested subprocess updates stay separated", () => {
	const owner = result();
	const emitUpdate = () => {};
	processChildJsonEvent({ type: "tool_execution_start", toolCallId: "a", toolName: "subprocess", args: {} }, owner, emitUpdate);
	processChildJsonEvent({ type: "tool_execution_start", toolCallId: "b", toolName: "subprocess", args: {} }, owner, emitUpdate);
	processChildJsonEvent({ type: "tool_execution_update", toolCallId: "b", toolName: "subprocess", partialResult: { details: details([result({ agent: "beta" })]) } }, owner, emitUpdate);
	processChildJsonEvent({ type: "tool_execution_update", toolCallId: "a", toolName: "subprocess", partialResult: { details: details([result({ agent: "alpha" })]) } }, owner, emitUpdate);

	assert.equal(owner.nestedSubprocesses.find((call) => call.toolCallId === "a").details.results[0].agent, "alpha");
	assert.equal(owner.nestedSubprocesses.find((call) => call.toolCallId === "b").details.results[0].agent, "beta");
});

test("legacy subagent events are tracked and unrelated tool events are ignored", () => {
	const owner = result();
	assert.equal(applyNestedSubprocessEvent(owner, { type: "tool_execution_start", toolCallId: "read-1", toolName: "read", args: {} }), false);
	assert.equal(owner.nestedSubprocesses, undefined);

	assert.equal(applyNestedSubprocessEvent(owner, { type: "tool_execution_start", toolCallId: "legacy-1", toolName: "subagent", args: {} }), true);
	assert.equal(owner.nestedSubprocesses[0].toolName, "subagent");
	assert.equal(
		applyNestedSubprocessEvent(owner, {
			type: "tool_execution_end",
			toolCallId: "legacy-1",
			toolName: "subagent",
			result: { content: [{ type: "text", text: "legacy failed" }] },
			isError: true,
		}),
		true,
	);
	assert.equal(owner.nestedSubprocesses[0].status, "failed");
	assert.equal(owner.nestedSubprocesses[0].error, "legacy failed");
});

test("large nested details are conservatively capped", () => {
	const owner = result();
	const huge = "x".repeat(40_000);
	applyNestedSubprocessEvent(owner, {
		type: "tool_execution_update",
		toolCallId: "large",
		toolName: "subprocess",
		partialResult: { details: details([result({ agent: "large", task: huge, messages: [assistantText(huge)] })]) },
	});

	const nested = owner.nestedSubprocesses[0];
	assert.equal(nested.truncated, true);
	assert.equal(nested.details.results[0].messages.length, 0);
	assert.match(nested.details.results[0].task, /\[truncated\]/);
});

test("nested subprocess formatter renders recursive indented details", () => {
	const nested = [
		{
			toolCallId: "legacy-call-12345",
			toolName: "subagent",
			status: "completed",
			details: details([
				result({
					agent: "outer-nested",
					messages: [assistantText("outer done")],
					nestedSubprocesses: [
						{
							toolCallId: "inner-call",
							toolName: "subprocess",
							status: "running",
							details: details([result({ agent: "inner", exitCode: -1 })]),
						},
					],
				}),
			]),
		},
	];

	const text = formatNestedSubprocessesForDisplay(nested);
	assert.match(text, /subagent/);
	assert.match(text, /outer-nested/);
	assert.match(text, /inner/);
	assert.match(text, /↳/);
});
