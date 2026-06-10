import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "./agents.ts";
import { getAgentInstructionsFileName } from "./agents.ts";

export function formatLocalLocationalPrompt(ctx: ExtensionContext, systemPromptOptions: { contextFiles?: Array<{ path: string; content: string }> } | undefined, instructionsPath: string, content: string): string {
	const hasSameFolderContext = systemPromptOptions?.contextFiles?.some((file) => {
		const basename = path.basename(file.path).toLowerCase();
		return path.resolve(path.dirname(file.path)) === path.resolve(ctx.cwd) && (basename === "agents.md" || basename === "claude.md");
	}) ?? false;

	if (!hasSameFolderContext) {
		return `<project_context>\n\nProject-specific instructions and guidelines:\n\n<project_instructions path="${instructionsPath}">\n${content}\n</project_instructions>\n\n</project_context>`;
	}

	return `# ${getAgentInstructionsFileName()}\n\nThe following ${getAgentInstructionsFileName()} is more specific than any AGENTS.md loaded from the same folder. Follow it for this source root.\n\n${content}`;
}

function escapeXml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function formatSubprocessAgentManifest(agents: AgentConfig[]): string {
	const visible = agents.filter((agent) => agent.manifest);
	if (visible.length === 0) return "";
	const entries = visible
		.map(
			(agent) =>
				`  <agent>\n    <id>${escapeXml(agent.id)}</id>\n    <description>${escapeXml(agent.description)}</description>\n  </agent>`,
		)
		.join("\n");
	return `<available-subprocess-agents>\n${entries}\n</available-subprocess-agents>`;
}

