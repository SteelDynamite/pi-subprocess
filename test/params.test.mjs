import assert from "node:assert/strict";
import { test } from "node:test";
import { getAgentId, getMissingSessionError } from "../params.ts";

test("getAgentId prefers id over legacy agent", () => {
	assert.equal(getAgentId({ id: "new", agent: "old" }), "new");
	assert.equal(getAgentId({ agent: "old" }), "old");
});

test("getMissingSessionError reports missing session by mode", () => {
	assert.match(getMissingSessionError({ id: "a", task: "do" }), /single subagent call/);
	assert.match(getMissingSessionError({ tasks: [{ id: "a", session: "new", task: "one" }, { id: "b", task: "two" }] }), /parallel task 2/);
	assert.match(getMissingSessionError({ chain: [{ id: "a", task: "one" }] }), /chain step 1/);
	assert.equal(getMissingSessionError({ id: "a", session: "new", task: "do" }), undefined);
});
