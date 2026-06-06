import assert from "node:assert/strict";
import { test } from "node:test";
import {
	formatUsageStats,
	getDisplayItems,
	getFinalOutput,
	getNestedSubagentIds,
	getResultOutput,
	isFailedResult,
	truncateParallelOutput,
} from "../result.ts";

const assistant = (content, extra = {}) => ({ role: "assistant", content, ...extra });

test("getFinalOutput returns the last non-empty assistant text", () => {
	const messages = [
		assistant([{ type: "text", text: "real answer" }]),
		{ role: "custom", content: "<system-reminder />" },
		assistant([{ type: "text", text: "" }]),
	];

	assert.equal(getFinalOutput(messages), "real answer");
});

test("getFinalOutput skips whitespace-only assistant text", () => {
	const messages = [
		assistant([{ type: "text", text: "first" }]),
		assistant([{ type: "text", text: "  \n\t" }]),
	];

	assert.equal(getFinalOutput(messages), "first");
});

test("isFailedResult treats nonzero exit and error stop reasons as failures", () => {
	assert.equal(isFailedResult({ exitCode: 1, stopReason: "end" }), true);
	assert.equal(isFailedResult({ exitCode: 0, stopReason: "error" }), true);
	assert.equal(isFailedResult({ exitCode: 0, stopReason: "aborted" }), true);
	assert.equal(isFailedResult({ exitCode: 0, stopReason: "end" }), false);
});

test("getResultOutput prefers warning, final output, next intent, and error text", () => {
	assert.equal(
		getResultOutput({
			exitCode: 0,
			warning: "careful",
			nextSessionIntent: "resume",
			messages: [assistant([{ type: "text", text: "done" }])],
		}),
		'Warning: careful\n\ndone\n\nNext call to this subprocess agent should use session: "resume"',
	);
	assert.equal(
		getResultOutput({ exitCode: 1, errorMessage: "boom", stderr: "stderr", messages: [] }),
		"boom",
	);
});

test("truncateParallelOutput caps large utf8 output", () => {
	const output = "🙂".repeat(30_000);
	const truncated = truncateParallelOutput(output);
	assert.match(truncated, /Output truncated:/);
	assert.ok(Buffer.byteLength(truncated, "utf8") < Buffer.byteLength(output, "utf8"));
});

test("getDisplayItems and getNestedSubagentIds extract assistant text and tool calls", () => {
	const messages = [
		assistant([
			{ type: "text", text: "thinking" },
			{ type: "toolCall", name: "subprocess", arguments: { tasks: [{ id: "a" }, { agent: "b" }] } },
			{ type: "toolCall", name: "subagent", arguments: { id: "legacy" } },
			{ type: "toolCall", name: "read", arguments: { path: "x" } },
		]),
	];
	assert.deepEqual(getDisplayItems(messages), [
		{ type: "text", text: "thinking" },
		{ type: "toolCall", name: "subprocess", args: { tasks: [{ id: "a" }, { agent: "b" }] } },
		{ type: "toolCall", name: "subagent", args: { id: "legacy" } },
		{ type: "toolCall", name: "read", args: { path: "x" } },
	]);
	assert.deepEqual(getNestedSubagentIds(messages), ["a", "b", "legacy"]);
});

test("formatUsageStats formats nonzero stats compactly", () => {
	assert.equal(
		formatUsageStats({ input: 1200, output: 25, cacheRead: 0, cacheWrite: 2000, cost: 0.01234, contextTokens: 5000, turns: 2 }, "provider/model"),
		"2 turns ↑1.2k ↓25 W2.0k $0.0123 ctx:5.0k provider/model",
	);
});
