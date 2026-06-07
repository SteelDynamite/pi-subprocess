import assert from "node:assert/strict";
import { test } from "node:test";
import { appendCappedText } from "../stream-buffer.ts";

test("appendCappedText appends under cap and reports bytes", () => {
	assert.deepEqual(appendCappedText("ab", "cd", 4), {
		text: "abcd",
		truncated: false,
		bytes: 4,
	});
});

test("appendCappedText truncates without splitting utf8 characters", () => {
	const result = appendCappedText("", "ééé", 5);
	assert.equal(result.text, "éé");
	assert.equal(result.truncated, true);
	assert.equal(result.bytes, 6);
	assert.ok(Buffer.byteLength(result.text, "utf8") <= 5);
});
