# Synergy Plugin SDK

`@ericsanchezok/synergy-plugin` is the server-side plugin SDK for Synergy.

A plugin extends the runtime with one or more of these capabilities:

- custom tools
- lifecycle hooks around sessions, agenda runs, notes, engram search, and tool execution
- provider auth integration
- config and event observers

This package is for developers who want to add behavior to the Synergy runtime itself. Plugins do **not** run in the Web client. They run on the server/runtime side, inside the active Scope context, and can access:

- `ctx.client` — a Synergy SDK client pointed at the current server
- `ctx.scope` — the resolved Scope
- `ctx.directory` / `ctx.worktree` — the current workspace paths
- `ctx.serverUrl` — the current server URL
- `ctx.$` — Bun shell access for local runtime-side commands

If you want the smallest possible example, see [`src/example.ts`](./src/example.ts). It is intentionally minimal. The example in this README shows a more realistic shape.

## What a plugin looks like

A plugin module exports one or more async functions of type `Plugin`.
Each function is initialized once and returns a set of hooks and capabilities.
In practice, most plugins should export a single default plugin function.

```ts
import type { Plugin } from "@ericsanchezok/synergy-plugin"

const MyPlugin: Plugin = async (ctx) => {
  return {
    // hooks, tools, auth, config observer, event observer
  }
}

export default MyPlugin
```

A plugin function receives this runtime context:

```ts
type PluginInput = {
  client: ReturnType<typeof createSynergyClient>
  scope: {
    type: "global" | "project"
    id: string
    directory: string
    worktree: string
    // ...other scope metadata
  }
  directory: string
  worktree: string
  serverUrl: URL
  $: BunShell
}
```

## Setup

For an external plugin package:

```bash
bun add @ericsanchezok/synergy-plugin zod
```

Use ESM and export your plugin from your package entrypoint.
A typical package entry might look like this:

```ts
import type { Plugin } from "@ericsanchezok/synergy-plugin"

const MyPlugin: Plugin = async () => ({})

export default MyPlugin
```

If you are writing a local plugin directly in a Synergy config directory such as `.synergy/plugin/` or `~/.synergy/config/plugin/`, Synergy will install `@ericsanchezok/synergy-plugin` in that config directory automatically. Any additional dependencies declared in that directory's `package.json` are installed there as well.

## How plugins are loaded

Synergy loads plugins from two places:

### 1. Explicit plugin entries in `synergy.jsonc`

The config schema includes a top-level `plugin` field:

```jsonc
{
  "plugin": ["your-plugin-package"],
}
```

Those entries are resolved as module specifiers and loaded by the runtime.
Published plugin packages are installed automatically when needed.

### 2. Auto-discovered local plugin files

Synergy also scans these directories for `*.ts` and `*.js` files:

- project scope: `<project>/.synergy/plugin/` and `<project>/.synergy/plugins/`
- global config: `~/.synergy/config/plugin/` and `~/.synergy/config/plugins/`

This makes local development straightforward:

```text
my-project/
  .synergy/
    plugin/
      my-plugin.ts
```

A few practical details:

- plugins are initialized in the current runtime Scope
- every exported plugin function in a module is loaded once
- `default` export is the safest convention unless you intentionally want multiple plugin instances from one file
- reloading plugin state also reloads plugin-provided tools

## Minimal plugin

This is the smallest useful plugin: one observation hook and no custom tools.

```ts
import type { Plugin } from "@ericsanchezok/synergy-plugin"

const SessionLogger: Plugin = async () => {
  return {
    async "session.turn.after"(input) {
      if (input.error) {
        console.error("session turn failed", input.sessionID, input.error)
        return
      }

      console.log("session turn completed", input.sessionID, input.assistantMessageID)
    },
  }
}

export default SessionLogger
```

## Custom tools

Plugins can register tools by returning a `tool` map.
Use the `tool()` helper to define the tool schema and execution function.

```ts
import type { Plugin } from "@ericsanchezok/synergy-plugin"
import { tool } from "@ericsanchezok/synergy-plugin/tool"

const GitPlugin: Plugin = async (ctx) => {
  return {
    tool: {
      current_branch: tool({
        description: "Get the current git branch",
        args: {},
        async execute(_args, toolCtx) {
          const out = await ctx.$`git rev-parse --abbrev-ref HEAD`.cwd(ctx.worktree).quiet().text()

          return [`session: ${toolCtx.sessionID}`, `agent: ${toolCtx.agent}`, `branch: ${out.trim()}`].join("\n")
        },
      }),
    },
  }
}

export default GitPlugin
```

Tool execution receives a narrower context:

```ts
type ToolContext = {
  sessionID: string
  messageID: string
  agent: string
  abort: AbortSignal
}
```

A few things to know about plugin tools:

- tool args are defined with Zod shapes
- the helper returns plain text output; Synergy wraps it into the runtime tool result format
- long output may be truncated by the runtime, just like built-in tools
- if you need runtime context like Scope paths or shell access, close over the outer plugin `ctx`

## Hooks overview

If you want a current CLI list instead of reading source, run `synergy plugin hooks` or `synergy plugin hooks --json`.

Hooks fall into two broad categories.

### Observation hooks

These let you react to runtime events without changing the main result.
They either have no mutable output object, or their output is not used to drive the main flow.

Common examples:

- `event`
- `config`
- `session.turn.after`
- `cortex.task.after`
- `agenda.run.after`
- `agenda.run.error`
- `engram.experience.encode.after`

Use these for logging, metrics, side effects, external notifications, and indexing.

### Mutation hooks

These can shape what Synergy does by mutating the `output` object passed as the second argument.
The runtime passes an object, your hook edits it in place, and the updated object continues through the pipeline.

Common examples:

- `chat.message`
- `chat.params`
- `permission.ask`
- `tool.execute.before`
- `tool.execute.after`
- `agenda.run.before`
- `note.create.before`
- `note.update.before`
- `note.search.before`
- `note.search.after`
- `engram.memory.search.before`
- `engram.memory.search.after`
- `experimental.*` transform hooks

The rule of thumb is simple: treat `input` as context, and treat `output` as the thing you may change.

## Hook reference

### Core capabilities

| Hook / field | Purpose                                    | Typical use                                  |
| ------------ | ------------------------------------------ | -------------------------------------------- |
| `tool`       | Register custom tools                      | Runtime-side integrations, project utilities |
| `auth`       | Add provider auth methods and auth loaders | Custom providers, OAuth, API key flows       |
| `config`     | Observe loaded config                      | Initialize plugin state from current config  |
| `event`      | Observe bus events                         | Logging, metrics, passive integrations       |

### Chat and session hooks

| Hook                                   | Mutates output? | Notes                                                            |
| -------------------------------------- | --------------- | ---------------------------------------------------------------- |
| `chat.message`                         | Yes             | Inspect or rewrite incoming user message parts before processing |
| `chat.params`                          | Yes             | Adjust model parameters and provider options before LLM calls    |
| `session.turn.after`                   | No              | Observe the completed turn, including error state if present     |
| `experimental.chat.messages.transform` | Yes             | Rewrite the message history sent to the model                    |
| `experimental.chat.system.transform`   | Yes             | Rewrite the assembled system prompt                              |
| `experimental.session.compacting`      | Yes             | Add compaction context or replace the compaction prompt          |
| `experimental.text.complete`           | Yes             | Rewrite a text completion result                                 |

### Permission and tool hooks

| Hook                  | Mutates output? | Notes                                                   |
| --------------------- | --------------- | ------------------------------------------------------- |
| `permission.ask`      | Yes             | Override `ask` / `deny` / `allow` decisions             |
| `tool.execute.before` | Yes             | Rewrite tool args before execution                      |
| `tool.execute.after`  | Yes             | Rewrite tool output, title, or metadata after execution |

### Cortex and agenda hooks

| Hook                | Mutates output? | Notes                                                     |
| ------------------- | --------------- | --------------------------------------------------------- |
| `cortex.task.after` | No              | Observe completed Cortex task execution                   |
| `agenda.run.before` | Yes             | Skip a run or replace the `AgendaItem` used for execution |
| `agenda.run.after`  | No              | Observe a successful agenda run                           |
| `agenda.run.error`  | No              | Observe a failed agenda run                               |

### Note hooks

| Hook                 | Mutates output? | Notes                                                               |
| -------------------- | --------------- | ------------------------------------------------------------------- |
| `note.create.before` | Yes             | Rewrite note creation input before storage                          |
| `note.create.after`  | Usually no      | Observe the created note after persistence                          |
| `note.update.before` | Yes             | Rewrite the patch before update logic runs                          |
| `note.update.after`  | Usually no      | Observe the updated note after persistence                          |
| `note.search.before` | Yes             | Rewrite search pattern, scope, date filters, tags, or pinned filter |
| `note.search.after`  | Yes             | Filter or reorder returned notes                                    |

### Engram hooks

| Hook                             | Mutates output? | Notes                                                                      |
| -------------------------------- | --------------- | -------------------------------------------------------------------------- |
| `engram.memory.search.before`    | Yes             | Rewrite query, vector, top-k, categories, recall modes, or rerank behavior |
| `engram.memory.search.after`     | Yes             | Filter or rerank returned engram memory results                            |
| `engram.experience.encode.after` | No              | Observe whether an experience was encoded, skipped, or deduplicated        |

### Experimental hooks

Hooks under `experimental.*` are available, but they are less stable than the core hook surface. Use them when you need them, but expect them to evolve more quickly than the main plugin API.

## Short example

This example combines a custom tool with two hooks:

- `session.turn.after` for observation
- `note.search.after` for result shaping

```ts
import type { Plugin } from "@ericsanchezok/synergy-plugin"
import { tool } from "@ericsanchezok/synergy-plugin/tool"

const ExamplePlugin: Plugin = async (ctx) => {
  return {
    tool: {
      scope_info: tool({
        description: "Show the current Scope and worktree",
        args: {},
        async execute() {
          return [
            `scope: ${ctx.scope.id}`,
            `scopeType: ${ctx.scope.type}`,
            `directory: ${ctx.directory}`,
            `worktree: ${ctx.worktree}`,
          ].join("\n")
        },
      }),
    },

    async "session.turn.after"(input) {
      if (!input.error) {
        console.log("assistant replied in session", input.sessionID)
      }
    },

    async "note.search.after"(_input, output) {
      output.notes = output.notes.filter((note) => !note.tags.includes("private"))
    },
  }
}

export default ExamplePlugin
```

## Best practices

### Keep hooks fast

Most hooks run inline with real user work. If a hook blocks, the user feels it.
Do the minimum in the hook path. Push slow work to another system when possible.

### Be conservative with mutation

If you mutate an output object, make the change narrow and obvious.
A good plugin should be easy to reason about six months later.

### Treat Scope as real context

Plugins run inside a resolved Scope. Prefer `ctx.scope`, `ctx.directory`, and `ctx.worktree` over guessing from process state.

### Use `ctx.$` carefully

`ctx.$` is useful for local runtime-side commands, but it also makes it easy to couple a plugin to one machine or one repository layout. Shell out when that is the simplest correct answer, not by default.

### Prefer observation hooks for telemetry and indexing

If you only need to watch what happened, use an after-hook or `event` hook instead of intercepting earlier stages.

### Be explicit about note and engram behavior

Hooks like `note.search.after` and `engram.memory.search.after` can quietly change what users see. Document those policies in the plugin itself and keep them predictable.

### Expect experimental hooks to move

If your plugin depends on an `experimental.*` hook, isolate that logic so future API changes are easy to update.

### Export one plugin by default

A single default export keeps module behavior obvious. Multiple exported plugin functions are supported, but they are loaded independently.

## Auth plugins

A plugin can also provide `auth` for a custom provider. That is how plugins participate in provider-specific API key or OAuth flows and, when needed, compute provider options through an auth loader.

If you only need custom tools or hooks, you can ignore `auth` entirely.

## When to use a plugin vs other extension points

Use a plugin when you need runtime behavior:

- add a tool
- intercept a session, agenda, note, or engram lifecycle step
- integrate provider auth
- react to runtime events

Use other extension points when the problem is simpler:

- use `.synergy/command/` for reusable prompt commands
- use `.synergy/skill/` for domain instructions and workflows
- use config in `synergy.jsonc` for static runtime configuration

## Development notes

- local plugin files can live under `.synergy/plugin/` or `.synergy/plugins/`
- global plugin files can live under `~/.synergy/config/plugin/` or `~/.synergy/config/plugins/`
- explicit package plugins can be listed in `synergy.jsonc` under `plugin`
- plugin reload also refreshes plugin-provided tools

That is the core model: a plugin is an async server-side module that receives runtime context, returns hooks and tools, and participates directly in Scope-aware execution.
