# Subagent Example

Delegate tasks to specialized subagents with isolated context windows.

## Features

- **Isolated context**: Each subagent runs in a separate `pi` process
- **Streaming output**: See tool calls and progress as they happen
- **Parallel streaming**: All parallel tasks stream updates simultaneously
- **Markdown rendering**: Final output rendered with proper formatting (expanded view)
- **Usage tracking**: Shows turns, tokens, cost, and context usage per agent
- **Abort support**: Ctrl+C propagates to kill subagent processes

## Structure

```
subagent/
├── README.md            # This file
├── index.ts             # The extension (entry point)
├── agents.ts            # Agent discovery logic
├── agents/              # Sample agent definitions
│   ├── scout/SUBAGENTS.md     # Fast recon, returns compressed context
│   ├── planner/SUBAGENTS.md   # Creates implementation plans
│   ├── reviewer/SUBAGENTS.md  # Code review
│   └── worker/SUBAGENTS.md    # General-purpose (full capabilities)
└── prompts/             # Workflow presets (prompt templates)
    ├── implement.md     # scout -> planner -> worker
    ├── scout-and-plan.md    # scout -> planner (no implementation)
    └── implement-and-review.md  # worker -> reviewer -> worker
```

## Installation

From the repository root, symlink the files:

```bash
# Symlink the extension (must be in a subdirectory with index.ts)
mkdir -p ~/.pi/agent/extensions/subagent
ln -sf "$(pwd)/packages/coding-agent/examples/extensions/subagent/index.ts" ~/.pi/agent/extensions/subagent/index.ts
ln -sf "$(pwd)/packages/coding-agent/examples/extensions/subagent/agents.ts" ~/.pi/agent/extensions/subagent/agents.ts

# Symlink agents
mkdir -p ~/.pi/agent/agents
for d in packages/coding-agent/examples/extensions/subagent/agents/*; do
  ln -sfn "$(pwd)/$d" ~/.pi/agent/agents/$(basename "$d")
done

# Symlink workflow prompts
mkdir -p ~/.pi/agent/prompts
for f in packages/coding-agent/examples/extensions/subagent/prompts/*.md; do
  ln -sf "$(pwd)/$f" ~/.pi/agent/prompts/$(basename "$f")
done
```

## Security Model

This tool executes a separate `pi` subprocess with a delegated system prompt and tool/model configuration.

**Project-local behavioral agents** (`.pi/agents/<id>/SUBAGENTS.md`) and **locational agents** (source/contextual agents at `<source-root>/SUBAGENTS.md`) are repo-controlled prompts that can instruct the model to read files, run bash commands, etc.

**Default behavior:** Only loads **user-level agents** from `~/.pi/agent/agents`.

To enable project-local agents, pass `agentScope: "both"` (or `"project"`). Only do this for repositories you trust.

When running interactively, the tool prompts for confirmation before running project-local agents. Set `confirmProjectAgents: false` to disable.

## Usage

### Single agent
```
Use scout to find all authentication code
```

### Parallel execution
```
Run 2 scouts in parallel: one to find models, one to find providers
```

### Chained workflow
```
Use a chain: first have scout find the read tool, then have planner suggest improvements
```

### Workflow prompts
```
/implement add Redis caching to the session store
/scout-and-plan refactor auth to support OAuth
/implement-and-review add input validation to API endpoints
```

## Tool Modes

| Mode | Parameter | Description |
|------|-----------|-------------|
| Single | `{ id, session, task }` | One subagent id, required session intent (`"new"` or `"resume"`), one task (`agent` remains as a deprecated alias) |
| Parallel | `{ tasks: [...] }` | Multiple `{ id, session, task }` tasks run concurrently (max 8, 4 concurrent) |
| Chain | `{ chain: [...] }` | Sequential `{ id, session, task }` steps with `{previous}` placeholder |
| Locational advertisement | `includeSourceAgents?: boolean` | Allow behavioral-agent child sessions to advertise locational agents (source/contextual agents; default: `false`) |

Working directory defaults:
- Behavioral agents run from the caller's current cwd.
- Locational agents run from the source root named by `id`.
- `cwd` is a legacy behavioral-agent override; omit it for normal use.
- `session` is required on every subagent call. Use `"new"` for a first/fresh prompt and `"resume"` only when the previous result said so.
- Behavioral-agent child sessions do not advertise locational agents by default. Set `includeSourceAgents: true` when a behavioral agent should orchestrate locational agents. Top-level locational delegation and source-boundary enforcement still work.

## Output Display

**Collapsed view** (default):
- Status icon (✓/✗/⏳), agent name, and session intent (`new`/`resume`)
- Last 5-10 items (tool calls and text)
- Usage stats: `3 turns ↑input ↓output RcacheRead WcacheWrite $cost ctx:contextTokens model`

**Expanded view** (Ctrl+O):
- Full task text
- Agent/status metadata including session intent
- All tool calls with formatted arguments
- Final output rendered as Markdown
- Per-task usage (for chain/parallel)

**Parallel mode streaming**:
- Shows all tasks with live status (⏳ running, ✓ done, ✗ failed)
- Updates as each task makes progress
- Shows "2/3 done, 1 running" status
- Returns each completed task's final output to the parent model, capped at 50 KB per task
- Returns failure diagnostics from stderr/error messages when a child exits before producing output

**Tool call formatting** (mimics built-in tools):
- `$ command` for bash
- `read ~/path:1-10` for read
- `grep /pattern/ in ~/path` for grep
- etc.

## Agent Definitions

Behavioral agents are folders containing `SUBAGENTS.md`; the folder name is the id. `name` frontmatter is not supported.

```markdown
---
description: What this agent does
tools: read, grep, find, ls
model: openai-codex/gpt-5.5, openai-codex/gpt-5.4-mini
manifest: true
resumable: false
---

System prompt for the agent goes here.
```

**Locations:**
- `~/.pi/agent/agents/<id>/SUBAGENTS.md` - User-level (always loaded)
- `.pi/agents/<id>/SUBAGENTS.md` - Project-level (only with `agentScope: "project"` or `"both"`)

Project agents override user agents with the same id when `agentScope: "both"`.

## Locational Agents

Any descendant folder containing `SUBAGENTS.md` becomes a locational boundary. The manifest advertises locational agents by absolute path id, unless `manifest: false` is set. Direct reads/edits/searches/commands inside those folders are blocked; delegate with `id: "/absolute/source/root"` or a caller-cwd-relative path. The source root from `id` is used as the subagent cwd. Locational agents cannot delegate to their own current source root or another source root already in the delegation stack. Locational agents do not trigger a startup notification; boundary messages appear only when direct access is blocked during use. Behavioral-agent child sessions hide locational-agent advertisements unless the parent call sets `includeSourceAgents: true`; source-boundary guards remain active.

`SUBAGENTS.md` also replaces same-folder `AGENTS.md` by convention. When Pi starts in a locational-agent folder with `SUBAGENTS.md` but no same-folder `AGENTS.md` or `CLAUDE.md`, this extension injects `SUBAGENTS.md` in the same project-context shape Pi uses for context files. If same-folder context already exists, the extension injects `SUBAGENTS.md` after normal context and states that it is more specific.

Only these frontmatter fields are supported: `description`, `tools`, `model`, `manifest`, `resumable`. If `tools` is present, it is an exact allowlist; omit it to inherit defaults. If `model` is a comma-separated list, the first configured/available model is used; otherwise the caller model is used with a warning. `resumable` defaults to `false` for behavioral agents and `true` for locational agents.

Locational-agent discovery is bounded so starting Pi from broad folders does not scan indefinitely. Defaults: max depth `6`, timeout `500ms`. Override with `PI_SUBAGENT_SOURCE_SCAN_MAX_DEPTH` and `PI_SUBAGENT_SOURCE_SCAN_TIMEOUT_MS`.

## Resumable Sessions

Resumable sessions are tracked per main session and subagent id. A resumable result reports only the next required intent: `Next call to this subagent should use session: "resume"` or `"new"`. Calls with the wrong intent are blocked before spawning; over-limit blocks say to craft a fresh-session task prompt. The context threshold defaults to 60%.

Use `/subagent-settings` to toggle reuse, set the context threshold, view active resumable sessions, or reset tracked resumable sessions for the current main session.

## Sample Agents

| Agent | Purpose | Model | Tools |
|-------|---------|-------|-------|
| `scout` | Fast codebase recon | Haiku | read, grep, find, ls, bash |
| `planner` | Implementation plans | Sonnet | read, grep, find, ls |
| `reviewer` | Code review | Sonnet | read, grep, find, ls, bash |
| `worker` | General-purpose | Sonnet | (all default) |

## Workflow Prompts

| Prompt | Flow |
|--------|------|
| `/implement <query>` | scout → planner → worker |
| `/scout-and-plan <query>` | scout → planner |
| `/implement-and-review <query>` | worker → reviewer → worker |

## Error Handling

- **Exit code != 0**: Tool returns error with stderr/output
- **stopReason "error"**: LLM error propagated with error message
- **stopReason "aborted"**: User abort (Ctrl+C) kills subprocess, throws error
- **Chain mode**: Stops at first failing step, reports which step failed

## Limitations

- Output truncated to last 10 items in collapsed view (expand to see all)
- Parallel model-visible output is capped at 50 KB per task; full results remain in tool details
- Agents discovered fresh on each invocation (allows editing mid-session)
- Parallel mode limited to 8 tasks, 4 concurrent
