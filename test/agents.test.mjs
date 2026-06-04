import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { discoverAgents, isPathInside, loadLocationalAgent, resolveLocationalAgentId, scanLocationalAgents } from "../agents.ts";

function tempDir() {
	return mkdtempSync(join(tmpdir(), "pi-subagent-agents-test-"));
}

test("loadLocationalAgent parses frontmatter, defaults, and same-root @includes", () => {
	const root = tempDir();
	try {
		writeFileSync(join(root, "extra.md"), "included body");
		writeFileSync(join(root, "SUBAGENTS.md"), "---\ndescription: Test\ntools: read, bash\nmanifest: false\nresumable: no\n---\n@extra.md\n");
		const { agent, error } = loadLocationalAgent(root, { readBody: true });
		assert.equal(error, undefined);
		assert.equal(agent.description, "Test");
		assert.deepEqual(agent.tools, ["read", "bash"]);
		assert.equal(agent.manifest, false);
		assert.equal(agent.resumable, false);
		assert.equal(agent.systemPrompt, "included body");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("loadLocationalAgent reports unsupported frontmatter", () => {
	const root = tempDir();
	try {
		writeFileSync(join(root, "SUBAGENTS.md"), "---\nunknown: value\n---\nBody\n");
		const { agent, error } = loadLocationalAgent(root, { readBody: true });
		assert.equal(agent, undefined);
		assert.match(error, /unsupported frontmatter/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("scanLocationalAgents finds nested locational roots, skips node_modules, and resolveLocationalAgentId works", () => {
	const root = tempDir();
	try {
		const owned = join(root, "owned");
		const skipped = join(root, "node_modules", "owned");
		mkdirSync(owned, { recursive: true });
		mkdirSync(skipped, { recursive: true });
		writeFileSync(join(owned, "SUBAGENTS.md"), "---\ndescription: Owned\n---\nBody\n");
		writeFileSync(join(skipped, "SUBAGENTS.md"), "---\ndescription: Skipped\n---\nBody\n");

		const scan = scanLocationalAgents(root, { maxDepth: 4, timeoutMs: 1000 });
		assert.deepEqual(scan.agents.map((a) => a.rootDir), [realpathSync(owned)]);
		assert.equal(resolveLocationalAgentId(root, "owned").rootDir, realpathSync(owned));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("discoverAgents can omit locational agents without changing behavioral-agent scope", () => {
	const root = tempDir();
	try {
		const owned = join(root, "owned");
		mkdirSync(owned, { recursive: true });
		writeFileSync(join(owned, "SUBAGENTS.md"), "---\ndescription: Owned\n---\nBody\n");

		const withLocational = discoverAgents(root, "project", { includeLocationalAgents: true });
		const withoutLocational = discoverAgents(root, "project", { includeLocationalAgents: false });

		assert.ok(withLocational.locationalAgents.some((a) => a.rootDir === realpathSync(owned)));
		assert.equal(withoutLocational.locationalAgents.length, 0);
		assert.equal(withoutLocational.agents.some((a) => a.origin === "locational"), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("isPathInside includes root and descendants but excludes siblings", () => {
	const root = tempDir();
	try {
		mkdirSync(join(root, "child"));
		const sibling = `${root}-sibling`;
		mkdirSync(sibling);
		try {
			assert.equal(isPathInside(root, root), true);
			assert.equal(isPathInside(join(root, "child"), root), true);
			assert.equal(isPathInside(sibling, root), false);
		} finally {
			rmSync(sibling, { recursive: true, force: true });
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
