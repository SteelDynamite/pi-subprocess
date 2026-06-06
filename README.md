# Pi Subprocess

Foreground-managed subprocess orchestration for Pi Coding Agent.

Run specialized Pi agents with isolated contexts, or run shell commands, while the parent agent waits for consolidated results. Detached/fire-and-forget jobs are intentionally out of scope.

## Features

- **Agent subprocesses**: behavioral and locational Pi agents run in separate `pi` processes.
- **Command subprocesses**: shell commands run with bounded foreground parallelism.
- **Streaming progress**: single, parallel, chain, and command modes stream status.
- **Consolidated results**: parent receives final output, exit status, cwd, stderr/stdout, usage, and truncation metadata.
- **Abort support**: Ctrl+C propagates to child processes.
- **Compatibility**: the legacy `subagent` tool and package-era API aliases remain supported.

## Structure

```
pi-subprocess/
├── README.md
├── index.ts
├── agents.ts
├── command.ts
├── locational-guard.ts
├── agents/
│   ├── scout/SUBAGENTS.md
│   ├── planner/SUBAGENTS.md
│   ├── reviewer/SUBAGENTS.md
│   └── worker/SUBAGENTS.md
└── prompts/
    ├── implement.md
    ├── scout-and-plan.md
    └── implement-and-review.md
```

## Installation

From this repository root:

```bash
mkdir -p ~/.pi/agent/extensions/subprocess
ln -sf "$(pwd)/index.ts" ~/.pi/agent/extensions/subprocess/index.ts

mkdir -p ~/.pi/agent/agents
for d in agents/*; do
  ln -sfn "$(pwd)/$d" ~/.pi/agent/agents/$(basename "$d")
done

mkdir -p ~/.pi/agent/prompts
for f in prompts/*.md; do
  ln -sf "$(pwd)/$f" ~/.pi/agent/prompts/$(basename "$f")
done
```

Legacy installs under `~/.pi/agent/extensions/subagent` can continue while migrating.

## Tool

Primary tool: `subprocess`.

Compatibility alias: `subagent`.

### Modes

| Mode | Parameter | Description |
|---|---|---|
| Single agent | `{ id, session, task }` | One behavioral or locational agent |
| Parallel agents | `{ tasks: [{ id, session, task }] }` | Multiple agent subprocesses, max 8, concurrency 4 |
| Chain | `{ chain: [{ id, session, task }] }` | Sequential agents; task may include `{previous}` |
| Commands | `{ commands: [{ command, name?, cwd?, timeoutMs?, maxOutputBytes? }] }` | Foreground-managed shell commands |

Agent calls require `session: "new" | "resume"`. Use `resume` only when the previous result says to.

### Examples

```json
{ "commands": [{ "name": "tests", "command": "npm test" }, { "name": "types", "command": "npm run typecheck" }] }
```

```json
{ "id": "scout", "session": "new", "task": "Find authentication code" }
```

## Agent Types

### Behavioral agents

Behavioral agents are folders containing `SUBAGENTS.md`:

- bundled: this repo's `agents/<id>/SUBAGENTS.md`
- user: `~/.pi/agent/agents/<id>/SUBAGENTS.md`
- project: `.pi/agents/<id>/SUBAGENTS.md` when `agentScope` is `project` or `both`

Project-local behavioral agents are repo-controlled prompts. Only enable them for trusted repositories.

### Locational agents

Any descendant folder containing `SUBAGENTS.md` becomes a locational boundary. The folder path is the agent id. Direct reads/edits/searches/commands inside such folders are blocked unless the user explicitly authorizes direct access for the current request.

Use the locational path as `id` to delegate instead. Locational agents run from their source root and cannot recursively delegate to their own current root or active ancestor stack.

`SUBAGENTS.md` also replaces same-folder `AGENTS.md` by convention. When Pi starts in a locational-agent folder with `SUBAGENTS.md` but no same-folder `AGENTS.md` or `CLAUDE.md`, this extension injects it as project context.

Supported frontmatter: `description`, `tools`, `model`, `manifest`, `resumable`.

Locational discovery defaults: max depth `6`, timeout `500ms`. New env vars: `PI_SUBPROCESS_LOCATIONAL_SCAN_MAX_DEPTH`, `PI_SUBPROCESS_LOCATIONAL_SCAN_TIMEOUT_MS`. Legacy `PI_SUBAGENT_*` vars still work where applicable.

## Child Environment

Delegated child processes receive:

- `PI_SUBPROCESS_CHILD=1`
- `PI_ORCHESTRATED_CHILD=1`

Legacy compatibility also sets `PI_SUBAGENT_CHILD=1`.

## Settings

Use `/subprocess-settings` to toggle resumable-session reuse, set the context threshold, view active sessions, or reset tracked sessions.

Legacy alias: `/subagent-settings`.

## Compatibility

Preserved aliases:

- tool: `subagent` → `subprocess`
- parameter: `agent` → `id`
- parameter: `includeSourceAgents` → `includeLocationalAgents`
- state/env compatibility for existing `subagent-state` and `PI_SUBAGENT_*` markers

## Non-goals

- detached jobs
- jobId polling
- schedulers or recurring tasks
- persistent daemons
- external task-type plugins
- cross-session job survival

## Validation

```bash
npm test
npm run typecheck
```
