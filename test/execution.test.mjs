import assert from "node:assert/strict";
import { test } from "node:test";
import { ADVERTISE_LOCATIONAL_AGENTS_ENV, ORCHESTRATED_CHILD_ENV, SUBAGENT_CHILD_ENV } from "../constants.ts";
import { makeSubagentChildEnv } from "../execution.ts";

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

test("makeSubagentChildEnv marks behavioral delegated children", () => {
	const env = makeSubagentChildEnv(agent("behavioral"), 2, false);
	assert.equal(env.PI_SUBAGENT_DEPTH, "3");
	assert.equal(env[SUBAGENT_CHILD_ENV], "1");
	assert.equal(env[ORCHESTRATED_CHILD_ENV], "1");
	assert.equal(env[ADVERTISE_LOCATIONAL_AGENTS_ENV], "0");
});

test("makeSubagentChildEnv marks locational delegated children and preserves locational env", () => {
	const env = makeSubagentChildEnv(agent("locational"), 0, false);
	assert.equal(env.PI_SUBAGENT_DEPTH, "1");
	assert.equal(env[SUBAGENT_CHILD_ENV], "1");
	assert.equal(env[ORCHESTRATED_CHILD_ENV], "1");
	assert.equal(env[ADVERTISE_LOCATIONAL_AGENTS_ENV], "1");
	assert.equal(env.PI_SUBAGENT_LOCATIONAL_ROOT, "/tmp/source-root");
});
