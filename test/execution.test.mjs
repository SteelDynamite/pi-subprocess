import assert from "node:assert/strict";
import { test } from "node:test";
import { ADVERTISE_LOCATIONAL_AGENTS_ENV, ORCHESTRATED_CHILD_ENV, SUBPROCESS_CHILD_ENV } from "../constants.ts";
import { makeSubprocessChildEnv } from "../execution.ts";

function agent(kind) {
	return {
		id: kind,
		description: "",
		manifest: true,
		systemPrompt: "",
		origin: kind === "locational" ? "locational" : "user",
		kind,
		filePath: "/tmp/SUBAGENTS.md",
		rootDir: "/tmp/source-root",
		resumable: false,
	};
}

test("makeSubprocessChildEnv marks behavioral delegated children", () => {
	const env = makeSubprocessChildEnv(agent("behavioral"), 2, false);
	assert.equal(env.PI_SUBPROCESS_DEPTH, "3");
	assert.equal(env.PI_SUBAGENT_DEPTH, "3");
	assert.equal(env[SUBPROCESS_CHILD_ENV], "1");
	assert.equal(env.PI_SUBAGENT_CHILD, "1");
	assert.equal(env[ORCHESTRATED_CHILD_ENV], "1");
	assert.equal(env[ADVERTISE_LOCATIONAL_AGENTS_ENV], "0");
});

test("makeSubprocessChildEnv marks locational delegated children and preserves locational env", () => {
	const env = makeSubprocessChildEnv(agent("locational"), 0, false);
	assert.equal(env.PI_SUBPROCESS_DEPTH, "1");
	assert.equal(env.PI_SUBAGENT_DEPTH, "1");
	assert.equal(env[SUBPROCESS_CHILD_ENV], "1");
	assert.equal(env.PI_SUBAGENT_CHILD, "1");
	assert.equal(env[ORCHESTRATED_CHILD_ENV], "1");
	assert.equal(env[ADVERTISE_LOCATIONAL_AGENTS_ENV], "1");
	assert.equal(env.PI_SUBPROCESS_LOCATIONAL_ROOT, "/tmp/source-root");
	assert.equal(env.PI_SUBAGENT_LOCATIONAL_ROOT, "/tmp/source-root");
});
