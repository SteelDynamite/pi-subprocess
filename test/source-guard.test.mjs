import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
	commandFilesystemTargets,
	getGuardedSourceRoots,
	getSourceAncestorStack,
	getSourceLoopError,
	makeChildSourceEnv,
	resolveFilesystemTarget,
} from "../source-guard.ts";
import { CURRENT_SOURCE_ROOT_ENV, LEGACY_CURRENT_SOURCE_ROOT_ENV, SOURCE_ANCESTOR_STACK_ENV } from "../constants.ts";

const originalEnv = {
	[CURRENT_SOURCE_ROOT_ENV]: process.env[CURRENT_SOURCE_ROOT_ENV],
	[LEGACY_CURRENT_SOURCE_ROOT_ENV]: process.env[LEGACY_CURRENT_SOURCE_ROOT_ENV],
	[SOURCE_ANCESTOR_STACK_ENV]: process.env[SOURCE_ANCESTOR_STACK_ENV],
};

function resetEnv() {
	for (const key of [CURRENT_SOURCE_ROOT_ENV, LEGACY_CURRENT_SOURCE_ROOT_ENV, SOURCE_ANCESTOR_STACK_ENV]) {
		if (originalEnv[key] === undefined) delete process.env[key];
		else process.env[key] = originalEnv[key];
	}
}

function clearEnv() {
	for (const key of [CURRENT_SOURCE_ROOT_ENV, LEGACY_CURRENT_SOURCE_ROOT_ENV, SOURCE_ANCESTOR_STACK_ENV]) delete process.env[key];
}

beforeEach(clearEnv);
afterEach(resetEnv);

function tempDir() {
	return mkdtempSync(join(tmpdir(), "pi-subagent-test-"));
}

test("resolveFilesystemTarget ignores URLs and resolves relative, bare, and home-like filesystem paths", () => {
	const root = tempDir();
	try {
		mkdirSync(join(root, "dir"));
		assert.equal(resolveFilesystemTarget(root, "https://example.com/x"), null);
		assert.equal(resolveFilesystemTarget(root, "dir", { allowBare: true }), realpathSync(join(root, "dir")));
		assert.equal(resolveFilesystemTarget(root, "./missing"), resolve(root, "missing"));
		assert.equal(resolveFilesystemTarget(root, "bare-missing"), null);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("commandFilesystemTargets extracts command path arguments and cwd options", () => {
	const root = tempDir();
	try {
		mkdirSync(join(root, "src"));
		mkdirSync(join(root, "work"));
		const targets = commandFilesystemTargets('cd src && git -C work status && cat "src/file.txt"', root);
		assert.ok(targets.includes(realpathSync(join(root, "src"))));
		assert.ok(targets.includes(realpathSync(join(root, "work"))));
		assert.ok(targets.includes(resolve(root, "src/file.txt")));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("source ancestor stack accepts JSON stack and current root, deduplicated", () => {
	const root = tempDir();
	const child = join(root, "child");
	mkdirSync(child);
	try {
		process.env[SOURCE_ANCESTOR_STACK_ENV] = JSON.stringify([root, root]);
		process.env[CURRENT_SOURCE_ROOT_ENV] = child;
		assert.deepEqual(getSourceAncestorStack(), [realpathSync(root), realpathSync(child)]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("getSourceLoopError blocks active source roots and makeChildSourceEnv appends child root", () => {
	const root = tempDir();
	const child = join(root, "child");
	mkdirSync(child);
	try {
		process.env[SOURCE_ANCESTOR_STACK_ENV] = JSON.stringify([root]);
		const agent = { id: child, kind: "source", rootDir: child };
		assert.equal(getSourceLoopError(agent), undefined);
		const env = makeChildSourceEnv(agent);
		assert.equal(env[CURRENT_SOURCE_ROOT_ENV], realpathSync(child));
		assert.deepEqual(JSON.parse(env[SOURCE_ANCESTOR_STACK_ENV]), [realpathSync(root), realpathSync(child)]);

		process.env[CURRENT_SOURCE_ROOT_ENV] = child;
		assert.match(getSourceLoopError(agent), /Locational delegation loop blocked/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("getGuardedSourceRoots finds nested source roots and excludes the active root", () => {
	const root = tempDir();
	const owned = join(root, "owned");
	try {
		mkdirSync(owned);
		writeFileSync(join(owned, "SUBAGENTS.md"), "---\ndescription: Owned\n---\nBody\n");
		assert.deepEqual(getGuardedSourceRoots(root), [realpathSync(owned)]);
		process.env[CURRENT_SOURCE_ROOT_ENV] = owned;
		assert.deepEqual(getGuardedSourceRoots(root), []);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
