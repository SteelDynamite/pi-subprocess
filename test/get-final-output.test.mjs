import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

function loadGetFinalOutput() {
	const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
	const start = source.indexOf("export function getFinalOutput");
	const end = source.indexOf("\n\nfunction isFailedResult", start);
	assert.notEqual(start, -1);
	assert.notEqual(end, -1);
	const fnSource = source
		.slice(start, end)
		.replace("export function getFinalOutput(messages: Message[]): string", "function getFinalOutput(messages)");
	return Function(`${fnSource}; return getFinalOutput;`)();
}

const getFinalOutput = loadGetFinalOutput();

test("getFinalOutput returns the last non-empty assistant text", () => {
	const messages = [
		{ role: "assistant", content: [{ type: "text", text: "real answer" }] },
		{ role: "custom", content: "<system-reminder />" },
		{ role: "assistant", content: [{ type: "text", text: "" }] },
	];

	assert.equal(getFinalOutput(messages), "real answer");
});

test("getFinalOutput skips whitespace-only assistant text", () => {
	const messages = [
		{ role: "assistant", content: [{ type: "text", text: "first" }] },
		{ role: "assistant", content: [{ type: "text", text: "  \n\t" }] },
	];

	assert.equal(getFinalOutput(messages), "first");
});
