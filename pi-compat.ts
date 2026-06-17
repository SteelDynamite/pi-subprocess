import { realpath } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { MarkdownTheme } from "@earendil-works/pi-tui";

export interface ExtensionUIContext {
	select(title: string, options: string[]): Promise<string | undefined>;
	confirm(title: string, message: string): Promise<boolean>;
	input(title: string, placeholder?: string): Promise<string | undefined>;
	notify(message: string, type?: "info" | "warning" | "error"): void;
}

export interface ExtensionContext {
	ui: ExtensionUIContext;
	hasUI: boolean;
	cwd: string;
	sessionManager: {
		getBranch(): Array<{ type?: string; customType?: string; data?: unknown }>;
		getSessionFile?(): string;
		getSessionId?(): string;
	};
	modelRegistry: {
		getAvailable(): Array<{ provider: string; id: string; contextWindow?: number }>;
	};
	model?: { provider: string; id: string; contextWindow?: number };
}

export interface ExtensionAPI {
	on(event: string, handler: (event: any, ctx: ExtensionContext) => unknown): void;
	registerCommand(name: string, options: { description?: string; handler: (args: unknown, ctx: ExtensionContext) => unknown }): void;
	registerTool(tool: any): void;
	appendEntry<T = unknown>(customType: string, data?: T): void;
}

export interface ParsedFrontmatter<T extends Record<string, unknown> = Record<string, unknown>> {
	frontmatter: T;
	body: string;
}

function normalizeNewlines(value: string): string {
	return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function stripQuotes(value: string): string {
	const trimmed = value.trim();
	if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

function parseScalar(value: string): unknown {
	const trimmed = value.trim();
	if (trimmed === "") return "";
	if (trimmed === "true") return true;
	if (trimmed === "false") return false;
	if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
		const body = trimmed.slice(1, -1).trim();
		return body ? body.split(",").map(stripQuotes) : [];
	}
	return stripQuotes(trimmed);
}

function parseSimpleYaml(yaml: string): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	const lines = yaml.split("\n");
	let pendingListKey: string | null = null;
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		if (pendingListKey && trimmed.startsWith("- ")) {
			(result[pendingListKey] as unknown[]).push(parseScalar(trimmed.slice(2)));
			continue;
		}
		pendingListKey = null;
		const match = trimmed.match(/^([^:]+):(.*)$/);
		if (!match) continue;
		const key = match[1].trim();
		const value = match[2].trim();
		if (value === "") {
			result[key] = [];
			pendingListKey = key;
			continue;
		}
		result[key] = parseScalar(value);
	}
	return result;
}

export function parseFrontmatter<T extends Record<string, unknown> = Record<string, unknown>>(content: string): ParsedFrontmatter<T> {
	const normalized = normalizeNewlines(content);
	if (!normalized.startsWith("---")) return { frontmatter: {} as T, body: normalized };
	const endIndex = normalized.indexOf("\n---", 3);
	if (endIndex === -1) return { frontmatter: {} as T, body: normalized };
	const yaml = normalized.slice(4, endIndex);
	const body = normalized.slice(endIndex + 4).trim();
	return { frontmatter: parseSimpleYaml(yaml) as T, body };
}

export function getAgentDir(): string {
	const envDir = process.env.PI_CODING_AGENT_DIR;
	if (envDir?.trim()) return envDir.startsWith("~/") ? path.join(os.homedir(), envDir.slice(2)) : path.resolve(envDir);
	return path.join(os.homedir(), ".pi", "agent");
}

const fileMutationQueues = new Map<string, Promise<void>>();
let registrationQueue = Promise.resolve();

function isMissingPathError(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && ((error as any).code === "ENOENT" || (error as any).code === "ENOTDIR");
}

async function getMutationQueueKey(filePath: string): Promise<string> {
	const resolvedPath = path.resolve(filePath);
	try {
		return await realpath(resolvedPath);
	} catch (error) {
		if (isMissingPathError(error)) return resolvedPath;
		throw error;
	}
}

export async function withFileMutationQueue<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
	const registration = registrationQueue.then(async () => {
		const key = await getMutationQueueKey(filePath);
		const currentQueue = fileMutationQueues.get(key) ?? Promise.resolve();
		let releaseNext!: () => void;
		const nextQueue = new Promise<void>((resolveQueue) => {
			releaseNext = resolveQueue;
		});
		const chainedQueue = currentQueue.then(() => nextQueue);
		fileMutationQueues.set(key, chainedQueue);
		return { key, currentQueue, chainedQueue, releaseNext };
	});
	registrationQueue = registration.then(() => undefined, () => undefined);
	const { key, currentQueue, chainedQueue, releaseNext } = await registration;
	await currentQueue;
	try {
		return await fn();
	} finally {
		releaseNext();
		if (fileMutationQueues.get(key) === chainedQueue) fileMutationQueues.delete(key);
	}
}

const identity = (text: string) => text;

export function getMarkdownTheme(): MarkdownTheme {
	return {
		heading: identity,
		link: identity,
		linkUrl: identity,
		code: identity,
		codeBlock: identity,
		codeBlockBorder: identity,
		quote: identity,
		quoteBorder: identity,
		hr: identity,
		listBullet: identity,
		bold: identity,
		italic: identity,
		strikethrough: identity,
		underline: identity,
	};
}

export type ToolUpdateCallback<TDetails> = (partial: AgentToolResult<TDetails>) => void;
