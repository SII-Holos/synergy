---
name: add-cli-command
description: "Guide for adding a new CLI command to Synergy. Use when implementing a new CLI subcommand, modifying command options, or extending the CLI. Triggers: 'add command', 'new command', 'CLI command', 'add subcommand', 'cli/cmd'."
---

# Adding a New CLI Command

## Location

CLI commands live in `packages/synergy/src/cli/cmd/`. Each command is a separate file exporting a named constant.

## Pattern

Commands use the `cmd()` wrapper function from `packages/synergy/src/cli/cmd/cmd.ts`. Always study an existing command before creating a new one.

```ts
import { cmd } from "./cmd"
import type { Argv } from "yargs"

export const MyCommand = cmd({
  command: "my-command [args..]",
  describe: "what this command does",
  builder: (yargs: Argv) =>
    yargs
      .option("flag", {
        type: "string",
        describe: "flag description",
      })
      .option("verbose", {
        alias: ["v"],
        type: "boolean",
        describe: "verbose output",
      }),
  handler: async (args) => {
    // Implementation
  },
})
```

Key points:

- Use `cmd()` wrapper, **not** raw `satisfies CommandModule`.
- Export a **named constant** (`export const MyCommand = ...`), not `export default`.
- Use `import type { Argv } from "yargs"` for the builder's type annotation.
- Aliases use `.alias(["a"])` chained on the option inside `builder`, not a top-level `alias` field.

## Steps

1. **Study existing commands** — look at `server.ts`, `status.ts`, `run.ts` for patterns
2. **Create the command file** in `packages/synergy/src/cli/cmd/<name>.ts`
3. **Register the command** — in `packages/synergy/src/index.ts`, import and add `.command(MyCommand)` to the yargs chain (around line 91–178)
4. **Handle errors gracefully** — use try/catch, provide helpful error messages
5. **Add describe text** — every command, option, and positional gets `describe` for `--help` output
6. **Test manually** — run via `bun run packages/synergy/src/index.ts <command>`
7. **Update docs** — add to README.md Common Commands section if user-facing

## CLI Entry Point

The CLI entry point is **`packages/synergy/src/index.ts`** (not `cli/index.ts`). This file:

- Constructs the root `yargs()` instance
- Registers all commands via `.command(SendCommand)`, `.command(ServerCommand)`, etc.
- Dynamically registers plugin commands via `registerPluginCommands(cli)`
- Calls `await cli.parse()` to execute

## Conventions

- Use kebab-case for command names: `my-command` not `myCommand`
- Provide short aliases when practical via `.alias()` in builder
- Print minimal output by default, verbose with `--verbose` flag
- Use `process.exit(1)` for error exits
- Import UI helpers from `packages/synergy/src/cli/ui.ts` for consistent formatting

## Reference Commands

| File                                     | Command  | What it demonstrates                                                   |
| ---------------------------------------- | -------- | ---------------------------------------------------------------------- |
| `packages/synergy/src/cli/cmd/server.ts` | `server` | Default command with network options, error formatting, daemon locking |
| `packages/synergy/src/cli/cmd/run.ts`    | `send`   | Positional args, file attachments, piped stdin, model/agent options    |
| `packages/synergy/src/cli/cmd/status.ts` | `status` | Server health check, formatted output                                  |

## Key Files

| File                                  | Purpose                                  |
| ------------------------------------- | ---------------------------------------- |
| `packages/synergy/src/index.ts`       | CLI entry point and command registration |
| `packages/synergy/src/cli/cmd/cmd.ts` | `cmd()` wrapper function                 |
| `packages/synergy/src/cli/cmd/`       | All command implementations              |
| `packages/synergy/src/cli/ui.ts`      | Shared UI helpers (colors, formatting)   |

## Quality Verification

Before committing a new CLI command:

```bash
bun run typecheck          # verify no type errors
bun run quality:quick      # format:check + lint + typecheck + monorepo:check + package:check
# Manual test:
bun run packages/synergy/src/index.ts my-command --help
```
