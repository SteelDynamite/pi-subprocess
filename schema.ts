import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

export const SessionIntentSchema = StringEnum(["new", "resume"] as const, {
	description: 'Required session intent. Use "new" for first/fresh calls and "resume" only when the previous result said so.',
});

const TaskItem = Type.Object({
	id: Type.Optional(Type.String({ description: "Subagent id to invoke" })),
	agent: Type.Optional(Type.String({ description: "Deprecated alias for id" })),
	session: SessionIntentSchema,
	task: Type.String({ description: "Task to delegate to the agent" }),
	cwd: Type.Optional(Type.String({ description: "Optional legacy cwd override for behavioral agents; omit normally" })),
});

const ChainItem = Type.Object({
	id: Type.Optional(Type.String({ description: "Subagent id to invoke" })),
	agent: Type.Optional(Type.String({ description: "Deprecated alias for id" })),
	session: SessionIntentSchema,
	task: Type.String({ description: "Task with optional {previous} placeholder for prior output" }),
	cwd: Type.Optional(Type.String({ description: "Optional legacy cwd override for behavioral agents; omit normally" })),
});

const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description: 'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
	default: "user",
});

export const SubagentParams = Type.Object({
	id: Type.Optional(Type.String({ description: "Subagent id to invoke (for single mode)" })),
	agent: Type.Optional(Type.String({ description: "Deprecated alias for id (single mode)" })),
	session: Type.Optional(SessionIntentSchema),
	task: Type.Optional(Type.String({ description: "Task to delegate (for single mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Array of {id, session, task} for parallel execution" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {id, session, task} for sequential execution" })),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgents: Type.Optional(
		Type.Boolean({ description: "Prompt before running project-local agents. Default: true.", default: true }),
	),
	includeLocationalAgents: Type.Optional(
		Type.Boolean({ description: "Allow behavioral-agent child sessions to advertise locational agents. Default: false.", default: false }),
	),
	includeSourceAgents: Type.Optional(
		Type.Boolean({ description: "Deprecated alias for includeLocationalAgents.", default: false }),
	),
	cwd: Type.Optional(Type.String({ description: "Optional legacy cwd override for behavioral agents (single mode); omit normally" })),
});
