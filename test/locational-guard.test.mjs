import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
	commandFilesystemTargets,
	getGuardedLocationalRoots,
	getLocationalAncestorStack,
	getLocationalLoopError,
	makeChildLocationalEnv,
	resolveFilesystemTarget,
} from "../locational-guard.ts";
import { CURRENT_LOCATIONAL_ROOT_ENV, LOCATIONAL_ANCESTOR_STACK_ENV } from "../constants.ts";

const trackedEnvKeys = [CURRENT_LOCATIONAL_ROOT_ENV, LOCATIONAL_ANCESTOR_STACK_ENV];
const originalEnv = Object.fromEntries(trackedEnvKeys.map((key) => [key, process.env[key]]));

function resetEnv() {
	for (const key of trackedEnvKeys) {
		if (originalEnv[key] === undefined) delete process.env[key];
		else process.env[key] = originalEnv[key];
	}
}

function clearEnv() {
	for (const key of trackedEnvKeys) delete process.env[key];
}

beforeEach(clearEnv);
afterEach(resetEnv);

function tempDir() {
	return mkdtempSync(join(tmpdir(), "pi-subprocess-test-"));
}

test("resolveFilesystemTarget ignores URLs and resolves relative, bare, and home-like filesystem paths", () => {
	const root = tempDir();
	try {
		mkdirSync(join(root, "dir"));
		assert.equal(resolveFilesystemTarget(root, "https://example.com/x"), null);
		assert.equal(resolveFilesystemTarget(root, "dir", { allowBare: true }), realpathSync.native(join(root, "dir")));
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
		assert.ok(targets.includes(realpathSync.native(join(root, "src"))));
		assert.ok(targets.includes(realpathSync.native(join(root, "work"))));
		assert.ok(targets.includes(resolve(root, "src/file.txt")));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("locational ancestor stack accepts JSON stack and current root, deduplicated", () => {
	const root = tempDir();
	const child = join(root, "child");
	mkdirSync(child);
	try {
		process.env[LOCATIONAL_ANCESTOR_STACK_ENV] = JSON.stringify([root, root]);
		process.env[CURRENT_LOCATIONAL_ROOT_ENV] = child;
		assert.deepEqual(getLocationalAncestorStack(), [realpathSync.native(root), realpathSync.native(child)]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("getLocationalLoopError blocks active locational roots and makeChildLocationalEnv appends child root", () => {
	const root = tempDir();
	const child = join(root, "child");
	mkdirSync(child);
	try {
		process.env[LOCATIONAL_ANCESTOR_STACK_ENV] = JSON.stringify([root]);
		const agent = { id: child, kind: "locational", rootDir: child };
		assert.equal(getLocationalLoopError(agent), undefined);
		const env = makeChildLocationalEnv(agent);
		assert.equal(env[CURRENT_LOCATIONAL_ROOT_ENV], realpathSync.native(child));
		assert.deepEqual(JSON.parse(env[LOCATIONAL_ANCESTOR_STACK_ENV]), [realpathSync.native(root), realpathSync.native(child)]);

		process.env[CURRENT_LOCATIONAL_ROOT_ENV] = child;
		assert.match(getLocationalLoopError(agent), /Locational delegation loop blocked/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("getGuardedLocationalRoots finds nested locational roots and excludes the active root", () => {
	const root = tempDir();
	const owned = join(root, "owned");
	try {
		mkdirSync(owned);
		writeFileSync(join(owned, "SUBAGENTS.md"), "---\ndescription: Owned\n---\nBody\n");
		assert.deepEqual(getGuardedLocationalRoots(root), [realpathSync.native(owned)]);
		process.env[CURRENT_LOCATIONAL_ROOT_ENV] = owned;
		assert.deepEqual(getGuardedLocationalRoots(root), []);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
