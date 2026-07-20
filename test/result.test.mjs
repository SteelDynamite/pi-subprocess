import assert from "node:assert/strict";
import { test } from "node:test";
import {
	formatUsageStats,
	getDisplayItems,
	getFinalOutput,
	getNestedSubprocessIds,
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
	assert.equal(isFailedResult({ exitCode: 0, stopReason: "context_limit" }), true);
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

test("getDisplayItems and getNestedSubprocessIds extract assistant text and tool calls", () => {
	const messages = [
		assistant([
			{ type: "text", text: "thinking" },
			{ type: "toolCall", name: "subprocess", arguments: { tasks: [{ id: "a" }, { id: "b" }] } },
			{ type: "toolCall", name: "read", arguments: { path: "x" } },
		]),
	];
	assert.deepEqual(getDisplayItems(messages), [
		{ type: "text", text: "thinking" },
		{ type: "toolCall", name: "subprocess", args: { tasks: [{ id: "a" }, { id: "b" }] } },
		{ type: "toolCall", name: "read", args: { path: "x" } },
	]);
	assert.deepEqual(getNestedSubprocessIds(messages), ["a", "b"]);
});

test("formatUsageStats appends fast only when PI_CHATGPT_FAST is 1", () => {
	const originalFast = process.env.PI_CHATGPT_FAST;
	const usage = { input: 1200, output: 25, cacheRead: 0, cacheWrite: 2000, cost: 0.01234, contextTokens: 5000, turns: 2 };
	try {
		process.env.PI_CHATGPT_FAST = "0";
		assert.equal(
			formatUsageStats(usage, "provider/model"),
			"2 turns ↑1.2k ↓25 W2.0k $0.0123 ctx:5.0k provider/model",
		);

		process.env.PI_CHATGPT_FAST = "1";
		assert.equal(
			formatUsageStats(usage, "provider/model"),
			"2 turns ↑1.2k ↓25 W2.0k $0.0123 ctx:5.0k provider/model fast",
		);
	} finally {
		if (originalFast === undefined) delete process.env.PI_CHATGPT_FAST;
		else process.env.PI_CHATGPT_FAST = originalFast;
	}
});
