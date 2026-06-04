export const MAX_PARALLEL_TASKS = 8;
export const MAX_CONCURRENCY = 4;
export const COLLAPSED_ITEM_COUNT = 10;
export const PER_TASK_OUTPUT_CAP = 50 * 1024;
export const MAX_SUBAGENT_DEPTH = 5;
export const DEFAULT_CONTEXT_THRESHOLD = 0.6;
export const SUBAGENT_STATE_ENTRY = "subagent-state";
export const CURRENT_SOURCE_ROOT_ENV = "PI_SUBAGENT_SOURCE_ROOT";
export const SOURCE_ANCESTOR_STACK_ENV = "PI_SUBAGENT_SOURCE_STACK";
export const LEGACY_CURRENT_SOURCE_ROOT_ENV = "PI_SUBAGENT_SKIP_LOCAL_SUBAGENTS";
export const ADVERTISE_SOURCE_AGENTS_ENV = "PI_SUBAGENT_ADVERTISE_SOURCE_AGENTS";
export const DEFAULT_KNOWN_TOOLS = new Set([
	"bash",
	"read",
	"write",
	"edit",
	"ls",
	"find",
	"grep",
	"rg",
	"todo",
	"subagent",
]);
