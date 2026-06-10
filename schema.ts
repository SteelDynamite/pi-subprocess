import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { DEFAULT_COMMAND_TIMEOUT_MS } from "./constants.ts";

export const SessionIntentSchema = StringEnum(["new", "resume"] as const, {
	description: 'Required session intent. Use "new" for first/fresh calls and "resume" only when the previous result said so.',
});

const HandoffDocFields = {
	contextDocs: Type.Optional(Type.Array(Type.String(), { description: "Director/project doc paths the child should read before starting" })),
	handoffDocs: Type.Optional(Type.Array(Type.String(), { description: "Alias for contextDocs" })),
};

const TaskItem = Type.Object({
	id: Type.Optional(Type.String({ description: "Subprocess agent id to invoke" })),
	session: SessionIntentSchema,
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Optional legacy cwd override for behavioral agents; omit normally" })),
	...HandoffDocFields,
});

const ChainItem = Type.Object({
	id: Type.Optional(Type.String({ description: "Subprocess agent id to invoke" })),
	session: SessionIntentSchema,
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Optional legacy cwd override for behavioral agents; omit normally" })),
	...HandoffDocFields,
});

const CommandItem = Type.Object({
	command: Type.String({ description: "Shell command to run as a foreground-managed subprocess" }),
	name: Type.Optional(Type.String({ description: "Optional display name for this command task" })),
	cwd: Type.Optional(Type.String({ description: "Optional working directory, resolved relative to the caller cwd" })),
	timeoutMs: Type.Optional(Type.Number({ description: `Optional wall-clock timeout in milliseconds. Defaults to ${DEFAULT_COMMAND_TIMEOUT_MS}.`, default: DEFAULT_COMMAND_TIMEOUT_MS })),
	maxOutputBytes: Type.Optional(Type.Number({ description: "Optional per-stream stdout/stderr capture cap in bytes" })),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

export const SubprocessParams = Type.Object({
	id: Type.Optional(Type.String({ description: "Subprocess agent id to invoke (for single mode)" })),
	session: Type.Optional(SessionIntentSchema),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	...HandoffDocFields,
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {id, session, task} for parallel subprocess-agent execution" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {id, session, task} for sequential subprocess-agent execution" })),
	commands: Type.Optional(Type.Array(CommandItem, { description: "Array of foreground-managed shell command tasks. Runs with bounded concurrency, waits for completion, and returns consolidated output." })),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
	),
	includeLocationalAgents: Type.Optional(
		Type.Boolean({ description: "Allow behavioral-agent child sessions to advertise locational agents. Default: false.", default: false }),
	),
	cwd: Type.Optional(Type.String({ description: "Optional legacy cwd override for behavioral agents (single mode); omit normally" })),
});
