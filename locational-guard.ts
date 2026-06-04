import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "./agents.ts";
import { getSubagentsFileName, scanLocationalAgents } from "./agents.ts";
import { CURRENT_LOCATIONAL_ROOT_ENV, LEGACY_CURRENT_LOCATIONAL_ROOT_ENV, LOCATIONAL_ANCESTOR_STACK_ENV } from "./constants.ts";

const notifiedLocationalBoundaryKeys = new Set<string>();

export function notifyLocationalBoundaryDiscovered(ctx: ExtensionContext, root: string) {
	if (!ctx.hasUI) return;
	const key = `${path.resolve(ctx.cwd)}\0${path.resolve(root)}`;
	if (notifiedLocationalBoundaryKeys.has(key)) return;
	notifiedLocationalBoundaryKeys.add(key);
	ctx.ui.notify(`Locational boundary discovered: delegate to subagent id "${root}"`, "info");
}

export function canonicalPath(value: string): string {
	const resolved = path.resolve(value);
	try {
		return fs.realpathSync.native(resolved);
	} catch {
		return resolved;
	}
}

function getEnvLocationalRoot(name: string): string | undefined {
	const value = process.env[name]?.trim();
	return value ? canonicalPath(value) : undefined;
}

export function getLocationalAncestorStack(): string[] {
	const raw = process.env[LOCATIONAL_ANCESTOR_STACK_ENV]?.trim();
	const roots: string[] = [];
	if (raw) {
		try {
			const parsed = JSON.parse(raw);
			if (Array.isArray(parsed)) roots.push(...parsed.filter((item): item is string => typeof item === "string"));
		} catch {
			roots.push(...raw.split(path.delimiter).filter(Boolean));
		}
	}
	const current = getEnvLocationalRoot(CURRENT_LOCATIONAL_ROOT_ENV) ?? getEnvLocationalRoot(LEGACY_CURRENT_LOCATIONAL_ROOT_ENV);
	if (current) roots.push(current);
	return Array.from(new Set(roots.map(canonicalPath)));
}

function formatLocationalLoopError(agent: AgentConfig, matchingRoot: string): string {
	const stack = getLocationalAncestorStack();
	const chain = [...stack, canonicalPath(agent.rootDir)].join(" -> ");
	return `Locational delegation loop blocked: locational agent "${agent.id}" resolves to "${canonicalPath(agent.rootDir)}", which is already active as "${matchingRoot}".${chain ? ` Stack: ${chain}.` : ""}`;
}

export function getLocationalLoopError(agent: AgentConfig): string | undefined {
	if (agent.kind !== "locational") return undefined;
	const targetRoot = canonicalPath(agent.rootDir);
	const matchingRoot = getLocationalAncestorStack().find((root) => root === targetRoot);
	return matchingRoot ? formatLocationalLoopError(agent, matchingRoot) : undefined;
}

function findContainingLocationalRoot(cwd: string): string | undefined {
	let current = path.resolve(cwd);
	while (true) {
		if (fs.existsSync(path.join(current, getSubagentsFileName()))) return canonicalPath(current);
		const parent = path.dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

export function getGuardedLocationalRoots(cwd: string): string[] {
	const activeLocationalRoot = getEnvLocationalRoot(CURRENT_LOCATIONAL_ROOT_ENV) ?? getEnvLocationalRoot(LEGACY_CURRENT_LOCATIONAL_ROOT_ENV);
	const roots = scanLocationalAgents(cwd).agents.map((agent) => canonicalPath(agent.rootDir));
	const containingRoot = findContainingLocationalRoot(cwd);
	if (containingRoot) roots.push(containingRoot);
	return Array.from(new Set(roots)).filter((root) => !activeLocationalRoot || root !== activeLocationalRoot);
}

export function makeChildLocationalEnv(agent: AgentConfig): Record<string, string> {
	if (agent.kind !== "locational") return {};
	const targetRoot = canonicalPath(agent.rootDir);
	const stack = Array.from(new Set([...getLocationalAncestorStack(), targetRoot]));
	return {
		[CURRENT_LOCATIONAL_ROOT_ENV]: targetRoot,
		[LOCATIONAL_ANCESTOR_STACK_ENV]: JSON.stringify(stack),
		[LEGACY_CURRENT_LOCATIONAL_ROOT_ENV]: targetRoot,
	};
}

function isFilesystemIdentifier(value: string, cwd: string, options: { allowBare?: boolean } = {}): boolean {
	const trimmed = value.trim();
	if (!trimmed) return false;
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return false;
	if (/^git:[^/]/i.test(trimmed)) return false;
	if (path.isAbsolute(trimmed) || trimmed.startsWith("./") || trimmed.startsWith("../") || trimmed === "." || trimmed === ".." || trimmed.startsWith("~/")) return true;
	if (/[\\/]/.test(trimmed)) return true;
	return Boolean(options.allowBare && fs.existsSync(path.resolve(cwd, trimmed)));
}

export function resolveFilesystemTarget(cwd: string, value: string, options: { allowBare?: boolean } = {}): string | null {
	const trimmed = value.trim();
	if (!isFilesystemIdentifier(trimmed, cwd, options)) return null;
	const expanded = trimmed.startsWith("~/") ? path.join(os.homedir(), trimmed.slice(2)) : trimmed;
	const resolved = path.resolve(cwd, expanded);
	try {
		return fs.realpathSync.native(resolved);
	} catch {
		return resolved;
	}
}

function shellTokens(command: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: '"' | "'" | null = null;
	let escaped = false;
	for (const ch of command) {
		if (escaped) {
			current += ch;
			escaped = false;
			continue;
		}
		if (ch === "\\" && quote !== "'") {
			escaped = true;
			continue;
		}
		if ((ch === '"' || ch === "'") && !quote) {
			quote = ch;
			continue;
		}
		if (quote === ch) {
			quote = null;
			continue;
		}
		if (!quote && /\s/.test(ch)) {
			if (current) tokens.push(current);
			current = "";
			continue;
		}
		current += ch;
	}
	if (current) tokens.push(current);
	return tokens;
}

export function commandFilesystemTargets(command: string, cwd: string): string[] {
	const tokens = shellTokens(command);
	const targets: string[] = [];
	const optionNeedsValue = new Set(["-C", "--cwd", "--prefix", "--dir", "--directory", "--chdir", "--path", "--work-tree", "--git-dir"]);
	const pathArgCommands = new Set(["cd", "pushd", "popd", "ls", "cat", "stat", "tail", "head", "less", "more", "realpath", "readlink"]);
	const addTarget = (value: string, allowBare = false) => {
		const target = resolveFilesystemTarget(cwd, value, { allowBare });
		if (target) targets.push(target);
	};

	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		const commandName = path.basename(token);
		if (pathArgCommands.has(commandName) && tokens[i + 1]) addTarget(tokens[i + 1], true);
		if (optionNeedsValue.has(token) && tokens[i + 1]) {
			addTarget(tokens[i + 1], true);
			continue;
		}
		const optionMatch = token.match(/^(--(?:cwd|prefix|dir|directory|chdir|path|work-tree|git-dir))=(.+)$/);
		if (optionMatch) {
			addTarget(optionMatch[2], true);
			continue;
		}
		addTarget(token, false);
	}
	return targets;
}
