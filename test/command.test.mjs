import assert from "node:assert/strict";
import { test } from "node:test";
import { runCommandTask } from "../command.ts";
import { DEFAULT_COMMAND_TIMEOUT_MS } from "../constants.ts";
import { formatCommandResultOutput, getResultOutput, isFailedResult } from "../result.ts";

const cwd = process.cwd();

test("runCommandTask waits and captures stdout/stderr/metadata", async () => {
	const updates = [];
	const result = await runCommandTask(
		cwd,
		{ command: "printf hello && printf err >&2", name: "sample" },
		undefined,
		undefined,
		(update) => updates.push(update),
	);

	assert.equal(result.kind, "command");
	assert.equal(result.agent, "sample");
	assert.equal(result.exitCode, 0);
	assert.equal(result.cwd, cwd);
	assert.equal(result.stdout, "hello");
	assert.equal(result.stderr, "err");
	assert.equal(result.timeoutMs, DEFAULT_COMMAND_TIMEOUT_MS);
	assert.ok((result.durationMs ?? -1) >= 0);
	assert.ok(updates.length >= 2);
	assert.match(getResultOutput(result), /Exit: 0/);
	assert.match(getResultOutput(result), /## stdout\n\nhello/);
});

test("runCommandTask times out bounded commands", async () => {
	const result = await runCommandTask(
		cwd,
		{ command: 'node -e "setTimeout(() => {}, 1000)"', timeoutMs: 50 },
		undefined,
		undefined,
		undefined,
	);

	assert.equal(result.timedOut, true);
	assert.equal(result.stopReason, "timeout");
	assert.equal(result.timeoutMs, 50);
	assert.equal(isFailedResult(result), true);
	assert.match(result.stderr, /Command timed out after 50ms/);
});

test("runCommandTask reports nonzero exit and output truncation", async () => {
	const result = await runCommandTask(
		cwd,
		{ command: "printf 1234567890 && exit 7", maxOutputBytes: 5 },
		undefined,
		undefined,
		undefined,
	);

	assert.equal(result.exitCode, 7);
	assert.equal(isFailedResult(result), true);
	assert.equal(result.stdout, "12345");
	assert.equal(result.stdoutTruncated, true);
	assert.match(formatCommandResultOutput(result), /truncated/);
});
