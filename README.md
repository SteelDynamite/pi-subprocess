# Pi Subprocess

Foreground-managed subprocess orchestration for Pi Coding Agent.

Run specialized Pi agents with isolated contexts, or run shell commands, while the parent agent waits for consolidated results. Detached/fire-and-forget jobs are intentionally out of scope.

## Features

- **Agent subprocesses**: behavioral and locational Pi agents run in separate `pi` processes.
- **Command subprocesses**: shell commands run with bounded foreground parallelism.
- **Streaming progress**: single, parallel, chain, and command modes stream status.
- **Consolidated results**: parent receives final output, exit status, cwd, stderr/stdout, usage, truncation metadata, and clear context-limit failures.
- **Abort support**: Ctrl+C propagates to child processes.
- **Legacy readers**: old state/env records are still read where needed for safe migration cleanup.

## Structure

```
pi-subprocess/
├── README.md
├── index.ts
├── agents.ts
├── command.ts
├── locational-guard.ts
└── agents/
    ├── scout/SUBAGENTS.md
    ├── planner/SUBAGENTS.md
    ├── reviewer/SUBAGENTS.md
    ├── spark/SUBAGENTS.md
    └── worker/SUBAGENTS.md
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
```

## Tool

Tool name: `subprocess`.

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

Locational agents with `model:` use that comma-separated candidate list first, then fall back to the caller model if none are available. Locational agents without `model:` use `PI_SUBPROCESS_LOCATIONAL_PREFERRED_MODELS` as preferred candidates before the caller model when the env is set to a non-empty list. If the env is unset, they use the caller model directly. Set env to empty to disable preferred-model behavior explicitly. If an explicit or preferred locational model fails before meaningful task work because of a model/provider/rate/auth/pre-start/context-limit error, pi-subprocess retries once in the same child session id with the caller model and reports the fallback in the result warning/details.

Agent failures that look like context-window exhaustion are reported with `stopReason: "context_limit"` and a clear error message containing the matched evidence. Detection checks child Pi JSON events, stderr, captured non-JSON stdout, error messages, and final assistant output.

Locational discovery defaults: max depth `6`, timeout `500ms`. Use `PI_SUBPROCESS_LOCATIONAL_SCAN_MAX_DEPTH` and `PI_SUBPROCESS_LOCATIONAL_SCAN_TIMEOUT_MS` to override them.

## Child Environment

Agent and command subprocess child processes receive:

- `PI_SUBPROCESS_CHILD=1`
- `PI_ORCHESTRATED_CHILD=1`

## Settings

Use `/subprocess-settings` to toggle resumable-session reuse, set the context threshold, view active sessions, or reset tracked sessions.

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
