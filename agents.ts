/**
 * Agent discovery and configuration
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type AgentScope = "user" | "project" | "both";
export type AgentOrigin = "bundled" | "user" | "project" | "locational";
export type AgentKind = "behavioral" | "locational";

export interface AgentConfig {
	id: string;
	description: string;
	tools?: string[];
	model?: string;
	manifest: boolean;
	systemPrompt: string;
	origin: AgentOrigin;
	kind: AgentKind;
	filePath: string;
	rootDir: string;
	resumable: boolean;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
	locationalAgents: AgentConfig[];
	errors: string[];
}

const SUBAGENTS_FILE = "SUBAGENTS.md";
const DEFAULT_LOCATIONAL_SCAN_MAX_DEPTH = 6;
const DEFAULT_LOCATIONAL_SCAN_TIMEOUT_MS = 500;
const ALLOWED_FRONTMATTER_KEYS = new Set(["description", "tools", "model", "manifest", "resumable"]);
const SKIP_LOCATIONAL_SCAN_DIRS = new Set([
	".git",
	".hg",
	".svn",
	".pi",
	"node_modules",
	"dist",
	"build",
	"out",
	".next",
	".nuxt",
	".svelte-kit",
	"coverage",
	".cache",
	".turbo",
	".parcel-cache",
	"target",
	"vendor",
	"Library",
	"Temp",
	"Logs",
	"obj",
	"bin",
]);

const DEFAULT_LOCATIONAL_PROMPT = `You are a locational subagent. This directory is your source root.

Work only within this source root unless the task explicitly asks otherwise. If you discover nested locational folders listed in <available-subagents>, delegate work inside them instead of inspecting or modifying them directly.`;

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function isSymlink(p: string): boolean {
	try {
		return fs.lstatSync(p).isSymbolicLink();
	} catch {
		return false;
	}
}

function readPositiveIntegerEnv(name: string, defaultValue: number): number {
	const value = process.env[name]?.trim();
	if (!value) return defaultValue;
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed > 0 ? parsed : defaultValue;
}

function parseTools(value: unknown): string[] | undefined {
	if (value === undefined || value === null) return undefined;
	if (Array.isArray(value)) {
		const tools = value.map((v) => String(v).trim()).filter(Boolean);
		return tools.length > 0 ? tools : undefined;
	}
	const tools = String(value)
		.split(",")
		.map((t) => t.trim())
		.filter(Boolean);
	return tools.length > 0 ? tools : undefined;
}

function parseBoolean(value: unknown, defaultValue: boolean): boolean {
	if (value === undefined || value === null) return defaultValue;
	if (typeof value === "boolean") return value;
	const normalized = String(value).trim().toLowerCase();
	if (["false", "no", "0", "off"].includes(normalized)) return false;
	if (["true", "yes", "1", "on"].includes(normalized)) return true;
	return defaultValue;
}

function resolveAtIncludes(body: string, baseDir: string): string {
	return body
		.split("\n")
		.map((line) => {
			const trimmed = line.trim();
			if (!trimmed.startsWith("@") || trimmed.includes(" ")) return line;
			const includePath = path.resolve(baseDir, trimmed.slice(1));
			const rel = path.relative(baseDir, includePath);
			if (rel.startsWith("..") || path.isAbsolute(rel)) return line;
			try {
				if (fs.statSync(includePath).isFile()) return fs.readFileSync(includePath, "utf-8");
			} catch {
				return line;
			}
			return line;
		})
		.join("\n");
}

function readSubagentContent(filePath: string, readBody: boolean): string {
	if (readBody) return fs.readFileSync(filePath, "utf-8");

	const fd = fs.openSync(filePath, "r");
	try {
		const chunks: Buffer[] = [];
		const buffer = Buffer.alloc(4096);
		let text = "";
		let total = 0;

		while (total < 64 * 1024) {
			const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
			if (bytesRead <= 0) break;
			chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
			total += bytesRead;
			text = Buffer.concat(chunks).toString("utf-8");

			if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) return "";

			const match = text.match(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/);
			if (match) return match[0];
		}

		return text.startsWith("---\n") || text.startsWith("---\r\n") ? text : "";
	} finally {
		fs.closeSync(fd);
	}
}

function loadSubagentFile(
	filePath: string,
	id: string,
	origin: AgentOrigin,
	kind: AgentKind,
	options: { readBody: boolean; rootDir?: string },
): { agent?: AgentConfig; error?: string } {
	let content: string;
	try {
		content = readSubagentContent(filePath, options.readBody);
	} catch (error) {
		return { error: `${filePath}: failed to read (${String(error)})` };
	}

	const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(content);
	const keys = Object.keys(frontmatter);
	const unknownKeys = keys.filter((k) => !ALLOWED_FRONTMATTER_KEYS.has(k));
	if (unknownKeys.length > 0) {
		return { error: `${filePath}: unsupported frontmatter field(s): ${unknownKeys.join(", ")}` };
	}

	const rootDir = options.rootDir ?? path.dirname(filePath);
	const rawBody = options.readBody ? resolveAtIncludes(body, rootDir).trim() : "";
	const systemPrompt = rawBody || (kind === "locational" ? DEFAULT_LOCATIONAL_PROMPT : "");

	return {
		agent: {
			id,
			description: frontmatter.description === undefined ? "" : String(frontmatter.description),
			tools: parseTools(frontmatter.tools),
			model: frontmatter.model === undefined ? undefined : String(frontmatter.model),
			manifest: parseBoolean(frontmatter.manifest, true),
			resumable: parseBoolean(frontmatter.resumable, kind === "locational"),
			systemPrompt,
			origin,
			kind,
			filePath,
			rootDir,
		},
	};
}

function loadBehavioralAgentsFromDir(dir: string, origin: "bundled" | "user" | "project"): { agents: AgentConfig[]; errors: string[] } {
	const agents: AgentConfig[] = [];
	const errors: string[] = [];

	if (!fs.existsSync(dir)) return { agents, errors };

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return { agents, errors };
	}

	for (const entry of entries) {
		const rootDir = path.join(dir, entry.name);
		if (!entry.isDirectory() && !(entry.isSymbolicLink() && isDirectory(rootDir))) continue;

		const filePath = path.join(rootDir, SUBAGENTS_FILE);
		if (!fs.existsSync(filePath)) continue;

		const loaded = loadSubagentFile(filePath, entry.name, origin, "behavioral", { readBody: true, rootDir });
		if (loaded.error) errors.push(loaded.error);
		if (loaded.agent) agents.push(loaded.agent);
	}

	return { agents, errors };
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = path.resolve(cwd);
	while (true) {
		const candidate = path.join(currentDir, ".pi", "agents");
		if (isDirectory(candidate)) return candidate;

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

export function loadLocationalAgent(rootDir: string, options: { readBody: boolean } = { readBody: true }): { agent?: AgentConfig; error?: string } {
	const absRoot = path.resolve(rootDir);
	const filePath = path.join(absRoot, SUBAGENTS_FILE);
	if (!fs.existsSync(filePath)) return { error: `${absRoot}: missing ${SUBAGENTS_FILE}` };
	return loadSubagentFile(filePath, absRoot, "locational", "locational", { readBody: options.readBody, rootDir: absRoot });
}

export function resolveLocationalAgentId(cwd: string, id: string): AgentConfig | null {
	const candidate = realPathIfExists(path.resolve(cwd, id));
	const filePath = path.join(candidate, SUBAGENTS_FILE);
	if (!fs.existsSync(filePath) || !isDirectory(candidate)) return null;
	const loaded = loadLocationalAgent(candidate, { readBody: true });
	return loaded.agent ?? null;
}

export function scanLocationalAgents(
	cwd: string,
	options: { maxDepth?: number; timeoutMs?: number } = {},
): { agents: AgentConfig[]; errors: string[] } {
	const roots: AgentConfig[] = [];
	const errors: string[] = [];
	const start = path.resolve(cwd);
	const maxDepth = options.maxDepth ?? readPositiveIntegerEnv("PI_SUBAGENT_LOCATIONAL_SCAN_MAX_DEPTH", DEFAULT_LOCATIONAL_SCAN_MAX_DEPTH);
	const timeoutMs = options.timeoutMs ?? readPositiveIntegerEnv("PI_SUBAGENT_LOCATIONAL_SCAN_TIMEOUT_MS", DEFAULT_LOCATIONAL_SCAN_TIMEOUT_MS);
	const startedAt = Date.now();
	let timedOut = false;

	function isTimedOut(): boolean {
		if (Date.now() - startedAt <= timeoutMs) return false;
		timedOut = true;
		return true;
	}

	function visit(dir: string, depth: number) {
		if (isTimedOut()) return;

		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}

		for (const entry of entries) {
			if (isTimedOut()) return;
			if (!entry.isDirectory()) continue;
			if (SKIP_LOCATIONAL_SCAN_DIRS.has(entry.name)) continue;

			const child = path.join(dir, entry.name);
			if (isSymlink(child)) continue;

			const subagentsPath = path.join(child, SUBAGENTS_FILE);
			if (fs.existsSync(subagentsPath)) {
				const loaded = loadLocationalAgent(child, { readBody: false });
				if (loaded.error) errors.push(loaded.error);
				if (loaded.agent) roots.push(loaded.agent);
				continue;
			}

			if (depth < maxDepth) visit(child, depth + 1);
		}
	}

	visit(start, 1);
	if (timedOut) {
		errors.push(`Locational subagent scan stopped after ${timeoutMs}ms. Increase PI_SUBAGENT_LOCATIONAL_SCAN_TIMEOUT_MS if needed.`);
	}
	return { agents: roots, errors };
}

export function discoverAgents(cwd: string, scope: AgentScope, options: { includeLocationalAgents?: boolean; includeSourceAgents?: boolean } = {}): AgentDiscoveryResult {
	const includeLocationalAgents = options.includeLocationalAgents ?? options.includeSourceAgents ?? true;
	const packageDir = path.dirname(fileURLToPath(import.meta.url));
	const bundledDir = path.join(packageDir, "agents");
	const userDir = path.join(getAgentDir(), "agents");
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);

	const bundled = loadBehavioralAgentsFromDir(bundledDir, "bundled");
	const user = scope === "project" ? { agents: [], errors: [] } : loadBehavioralAgentsFromDir(userDir, "user");
	const project =
		scope === "user" || !projectAgentsDir
			? { agents: [], errors: [] }
			: loadBehavioralAgentsFromDir(projectAgentsDir, "project");
	const locational = includeLocationalAgents ? scanLocationalAgents(cwd) : { agents: [], errors: [] };

	const agentMap = new Map<string, AgentConfig>();
	for (const agent of bundled.agents) agentMap.set(agent.id, agent);
	for (const agent of user.agents) agentMap.set(agent.id, agent);
	for (const agent of project.agents) agentMap.set(agent.id, agent);
	for (const agent of locational.agents) agentMap.set(agent.id, agent);

	return {
		agents: Array.from(agentMap.values()),
		projectAgentsDir,
		locationalAgents: locational.agents,
		errors: [...bundled.errors, ...user.errors, ...project.errors, ...locational.errors],
	};
}

export function formatAgentList(agents: AgentConfig[], maxItems: number): { text: string; remaining: number } {
	if (agents.length === 0) return { text: "none", remaining: 0 };
	const listed = agents.slice(0, maxItems);
	const remaining = agents.length - listed.length;
	return {
		text: listed.map((a) => `${a.id} (${a.origin}): ${a.description}`).join("; "),
		remaining,
	};
}

function realPathIfExists(p: string): string {
	try {
		return fs.realpathSync.native(p);
	} catch {
		return path.resolve(p);
	}
}

export function isPathInside(candidate: string, root: string): boolean {
	const rel = path.relative(realPathIfExists(root), realPathIfExists(candidate));
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function getSubagentsFileName(): string {
	return SUBAGENTS_FILE;
}
