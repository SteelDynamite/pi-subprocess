import assert from "node:assert/strict";
import { test } from "node:test";
import { makeCommandChildEnv, runCommandTask } from "../command.ts";
import { DEFAULT_COMMAND_TIMEOUT_MS, ORCHESTRATED_CHILD_ENV, SUBPROCESS_CHILD_ENV } from "../constants.ts";
import { formatCommandResultOutput, getResultOutput, isFailedResult } from "../result.ts";

const cwd = process.cwd();
const node = JSON.stringify(process.execPath);

test("runCommandTask waits and captures stdout/stderr/metadata", async () => {
	const updates = [];
	const result = await runCommandTask(
		cwd,
		{ command: `${node} -e "process.stdout.write('hello'); process.stderr.write('err')"`, name: "sample" },
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

test("runCommandTask marks command children as orchestrated subprocess children", async () => {
	const originalSubprocessChild = process.env[SUBPROCESS_CHILD_ENV];
	const originalOrchestratedChild = process.env[ORCHESTRATED_CHILD_ENV];
	try {
		process.env[SUBPROCESS_CHILD_ENV] = "0";
		process.env[ORCHESTRATED_CHILD_ENV] = "0";
		const result = await runCommandTask(
			cwd,
			{
				command: `${node} -e ${JSON.stringify(`process.stdout.write(process.env.${SUBPROCESS_CHILD_ENV} + ':' + process.env.${ORCHESTRATED_CHILD_ENV})`)}`,
				name: "env-markers",
			},
			undefined,
			undefined,
			undefined,
		);

		assert.equal(result.exitCode, 0);
		assert.equal(result.stdout, "1:1");
		const childEnv = makeCommandChildEnv({ [SUBPROCESS_CHILD_ENV]: "0", [ORCHESTRATED_CHILD_ENV]: "0" });
		assert.equal(childEnv[SUBPROCESS_CHILD_ENV], "1");
		assert.equal(childEnv[ORCHESTRATED_CHILD_ENV], "1");
	} finally {
		if (originalSubprocessChild === undefined) delete process.env[SUBPROCESS_CHILD_ENV];
		else process.env[SUBPROCESS_CHILD_ENV] = originalSubprocessChild;
		if (originalOrchestratedChild === undefined) delete process.env[ORCHESTRATED_CHILD_ENV];
		else process.env[ORCHESTRATED_CHILD_ENV] = originalOrchestratedChild;
	}
});

test("runCommandTask times out bounded commands", async () => {
	const result = await runCommandTask(
		cwd,
		{ command: `${node} -e "setTimeout(() => {}, 1000)"`, timeoutMs: 50 },
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
		{ command: `${node} -e "process.stdout.write('1234567890'); process.exit(7)"`, maxOutputBytes: 5 },
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
