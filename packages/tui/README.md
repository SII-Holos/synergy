# `@ericsanchezok/synergy-tui`

First-party terminal interface for the [Synergy](https://github.com/SII-Holos/synergy) agent runtime.

Most users should install Synergy and launch the integrated command:

```bash
synergy start
synergy tui
```

The TUI is a thin client of a running Synergy server. It presents the quiet Holos / Synergy workbench identity, the active conversation, streaming Markdown and reasoning, tool calls and diffs, Todo/DAG progress, commands, permissions, and questions without duplicating runtime state. Enter `/sessions` to browse and switch durable sessions in a modal picker; there is no persistent session sidebar.

## Programmatic use

```ts
import { runTui } from "@ericsanchezok/synergy-tui"

await runTui({
  baseUrl: "http://localhost:4096",
  directory: process.cwd(),
  theme: "system",
})
```

`directory` selects a project Scope. Use `scopeID` instead when the Scope is already known; the two options are mutually exclusive. `sessionID` selects the initial session, and `theme` accepts `system`, `light`, or `dark`.

`runTui()` owns the terminal lifecycle until the user quits or the process receives `SIGHUP`, `SIGINT`, or `SIGTERM`. Call it only with interactive terminal stdin and stdout.

## Development

From `packages/tui`:

```bash
bun run typecheck
bun test
bun run build
bun run compile:smoke
```

The package uses OpenTUI native libraries and includes optional dependencies for supported macOS, Linux glibc/musl, and Windows architectures. Their registry integrity hashes are pinned in `bun.lock`, and `bun run compile:smoke` compiles and executes the host native library. OpenTUI upgrades must refresh the lockfile and pass that smoke test on every release platform. Release packaging validates the built ESM and type exports with publint and Are the Types Wrong.

See the repository [CLI reference](../../docs/reference/cli.md) for commands and shortcuts, and [Frontend data sync](../../docs/architecture/frontend-data-sync.md#terminal-client-synchronization) for convergence guarantees.
