import assert from "node:assert/strict";
import { test } from "node:test";
import { addHandoffDocsToTask, getAgentId, getHandoffDocs, getMissingSessionError } from "../params.ts";

test("getAgentId returns only the id field", () => {
	assert.equal(getAgentId({ id: "new" }), "new");
	assert.equal(getAgentId({}), undefined);
});

test("getMissingSessionError reports missing session by mode", () => {
	assert.match(getMissingSessionError({ id: "a", task: "do" }), /single subprocess-agent call/);
	assert.match(getMissingSessionError({ tasks: [{ id: "a", session: "new", task: "one" }, { id: "b", task: "two" }] }), /parallel task 2/);
	assert.match(getMissingSessionError({ chain: [{ id: "a", task: "one" }] }), /chain step 1/);
	assert.equal(getMissingSessionError({ id: "a", session: "new", task: "do" }), undefined);
});

test("handoff docs are deduplicated and prefixed to child tasks", () => {
	const input = { contextDocs: [" /a.md ", "/b.md"], handoffDocs: ["/a.md"] };
	assert.deepEqual(getHandoffDocs(input), ["/a.md", "/b.md"]);
	assert.equal(
		addHandoffDocsToTask("Do work", input),
		"Before starting, read these handoff/context docs and follow any relevant product guidance:\n- /a.md\n- /b.md\n\nTask:\nDo work",
	);
	assert.equal(addHandoffDocsToTask("Do work", {}), "Do work");
});
