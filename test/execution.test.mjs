import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { ADVERTISE_LOCATIONAL_AGENTS_ENV, LOCATIONAL_PREFERRED_MODELS_ENV, ORCHESTRATED_CHILD_ENV, SUBPROCESS_CHILD_ENV } from "../constants.ts";
import { makeSubprocessChildEnv, runDelegation, resolveAgentModel, shouldRetryPreferredModelFailure } from "../execution.ts";

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
	assert.equal(env[SUBPROCESS_CHILD_ENV], "1");
	assert.equal(env[ORCHESTRATED_CHILD_ENV], "1");
	assert.equal(env[ADVERTISE_LOCATIONAL_AGENTS_ENV], "0");
});

test("makeSubprocessChildEnv marks locational delegated children and preserves locational env", () => {
	const env = makeSubprocessChildEnv(agent("locational"), 0, false);
	assert.equal(env.PI_SUBPROCESS_DEPTH, "1");
	assert.equal(env[SUBPROCESS_CHILD_ENV], "1");
	assert.equal(env[ORCHESTRATED_CHILD_ENV], "1");
	assert.equal(env[ADVERTISE_LOCATIONAL_AGENTS_ENV], "1");
	assert.equal(env.PI_SUBPROCESS_LOCATIONAL_ROOT, resolve("/tmp/source-root"));
});

function ctx(availableModels = [], currentModel = { provider: "caller", id: "default", contextWindow: 1000 }) {
	return {
		model: currentModel,
		modelRegistry: { getAvailable: () => availableModels },
	};
}

test("resolveAgentModel uses explicit locational model candidates before preferred models", () => {
	const local = { ...agent("locational"), model: "missing, explicit" };
	const resolved = resolveAgentModel(local, ctx([
		{ provider: "provider", id: "explicit", contextWindow: 2000 },
		{ provider: "provider", id: "gpt-5.3-codex-spark", contextWindow: 3000 },
	]));

	assert.equal(resolved.model, "provider/explicit");
	assert.equal(resolved.contextWindow, 2000);
	assert.equal(resolved.source, "agent");
	assert.equal(resolved.fallbackModel, "caller/default");
});

test("resolveAgentModel falls back to caller when explicit candidates are unavailable", () => {
	const local = { ...agent("locational"), model: "missing" };
	const resolved = resolveAgentModel(local, ctx([{ provider: "provider", id: "gpt-5.3-codex-spark", contextWindow: 3000 }]));

	assert.equal(resolved.model, "caller/default");
	assert.equal(resolved.source, "caller");
	assert.match(resolved.warning, /No configured model/);
});

test("resolveAgentModel uses caller model when locational preferred env is unset", () => {
	const old = process.env[LOCATIONAL_PREFERRED_MODELS_ENV];
	try {
		delete process.env[LOCATIONAL_PREFERRED_MODELS_ENV];
		const resolved = resolveAgentModel(agent("locational"), ctx([{ provider: "provider", id: "gpt-5.3-codex-spark", contextWindow: 3000 }]));

		assert.equal(resolved.model, "caller/default");
		assert.equal(resolved.source, "caller");
	} finally {
		if (old === undefined) delete process.env[LOCATIONAL_PREFERRED_MODELS_ENV];
		else process.env[LOCATIONAL_PREFERRED_MODELS_ENV] = old;
	}
});

test("resolveAgentModel uses env-configured locational preferred models and empty env disables", () => {
	const old = process.env[LOCATIONAL_PREFERRED_MODELS_ENV];
	try {
		process.env[LOCATIONAL_PREFERRED_MODELS_ENV] = "missing, spark-alt";
		let resolved = resolveAgentModel(agent("locational"), ctx([{ provider: "provider", id: "spark-alt", contextWindow: 3000 }]));
		assert.equal(resolved.model, "provider/spark-alt");
		assert.equal(resolved.source, "preferred");
		assert.equal(resolved.fallbackModel, "caller/default");

		process.env[LOCATIONAL_PREFERRED_MODELS_ENV] = "";
		resolved = resolveAgentModel(agent("locational"), ctx([{ provider: "provider", id: "spark-alt", contextWindow: 3000 }]));
		assert.equal(resolved.model, "caller/default");
		assert.equal(resolved.source, "caller");
	} finally {
		if (old === undefined) delete process.env[LOCATIONAL_PREFERRED_MODELS_ENV];
		else process.env[LOCATIONAL_PREFERRED_MODELS_ENV] = old;
	}
});

test("shouldRetryPreferredModelFailure only retries pre-work provider/model failures", () => {
	assert.equal(shouldRetryPreferredModelFailure({ exitCode: 1, stderr: "429 rate limit", messages: [] }), true);
	assert.equal(
		shouldRetryPreferredModelFailure({
			exitCode: 1,
			stderr: "429 rate limit",
			messages: [{ role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: "x" } }] }],
		}),
		false,
	);
	assert.equal(shouldRetryPreferredModelFailure({ exitCode: 1, stderr: "tests failed", messages: [] }), false);
});

test("runDelegation retries explicit locational model failures using caller model in same session", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-subprocess-explicit-fallback-"));
	const originalArgv1 = process.argv[1];
	const originalStateFile = process.env.PI_SUBPROCESS_TEST_STATE_FILE;
	try {
		const agentRoot = join(root, "loc-agent");
		mkdirSync(agentRoot);
		writeFileSync(
			join(agentRoot, "SUBAGENTS.md"),
			"---\nmodel: provider/explicit\nresumable: false\n---\n",
		);
		const stateFile = join(root, "state.json");
		writeFileSync(stateFile, "[]");
		const piPath = join(root, "fake-pi.js");
		writeFileSync(
			piPath,
			`const fs = require('node:fs');\n` +
				`const stateFile = process.env.PI_SUBPROCESS_TEST_STATE_FILE;\n` +
				`const args = process.argv.slice(2);\n` +
				`const modelIndex = args.indexOf('--model');\n` +
				`const model = modelIndex >= 0 ? args[modelIndex + 1] : '(default)';\n` +
				`const sessionIndex = args.indexOf('--session-id');\n` +
				`const sessionId = sessionIndex >= 0 ? args[sessionIndex + 1] : '';\n` +
				`const calls = (() => {\n` +
				`\ttry {\n` +
				`\t\treturn JSON.parse(fs.readFileSync(stateFile, 'utf8'));\n` +
				`\t} catch {\n` +
				`\t\treturn [];\n` +
				`\t}\n` +
				`})();\n` +
				`calls.push({ model, sessionId });\n` +
				`fs.writeFileSync(stateFile, JSON.stringify(calls));\n` +
				`if (model === 'provider/explicit' && calls.filter((entry) => entry.model === 'provider/explicit').length === 1) {\n` +
				`\tprocess.stderr.write('provider model unavailable');\n` +
				`\tprocess.exit(1);\n` +
				`}\n` +
				`const event = {\n` +
				`\ttype: 'message_end',\n` +
				`\tmessage: { role: 'assistant', content: [{ type: 'text', text: 'ok via ' + model }] },\n` +
				`};\n` +
				`console.log(JSON.stringify(event));\n` +
				`process.exit(0);\n`,
		);

		process.argv[1] = piPath;
		process.env.PI_SUBPROCESS_TEST_STATE_FILE = stateFile;

		const result = await runDelegation(
			{
				appendEntry: () => undefined,
			},
			{
				ui: {
					select: async () => undefined,
					confirm: async () => false,
					input: async () => undefined,
					notify: () => undefined,
				},
				hasUI: false,
				cwd: root,
				sessionManager: {
					getBranch: () => [],
				},
				model: { provider: "caller", id: "default", contextWindow: 1000 },
				modelRegistry: {
					getAvailable: () => [{ provider: "provider", id: "explicit", contextWindow: 2000 }],
				},
			},
			root,
			[],
			"loc-agent",
			"new",
			"Fallback test",
			undefined,
			undefined,
			undefined,
			undefined,
			(results) => ({
				mode: "single",
				agentScope: "user",
				includeLocationalAgents: false,
				projectAgentsDir: null,
				locationalAgents: [],
				results,
			}),
			false,
		);

		const calls = JSON.parse(readFileSync(stateFile, "utf8"));
		assert.equal(calls.length, 2);
		assert.equal(calls[0].model, "provider/explicit");
		assert.equal(calls[1].model, "caller/default");
		assert.equal(calls[0].sessionId, calls[1].sessionId);
		assert.ok(calls[0].sessionId);
		assert.equal(result.model, "caller/default");
		assert.match(result.warning ?? "", /Explicit locational model provider\/explicit failed before task work; retried with caller model caller\/default/);
	} finally {
		if (originalStateFile === undefined) {
			delete process.env.PI_SUBPROCESS_TEST_STATE_FILE;
		} else {
			process.env.PI_SUBPROCESS_TEST_STATE_FILE = originalStateFile;
		}
		process.argv[1] = originalArgv1;
		rmSync(root, { recursive: true, force: true });
	}
});
