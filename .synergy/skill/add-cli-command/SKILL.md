---
name: add-cli-command
description: "Guide for adding a new CLI command to Synergy. Use when implementing a new CLI subcommand, modifying command options, or extending the CLI. Triggers: 'add command', 'new command', 'CLI command', 'add subcommand', 'cli/cmd'."
---

# Adding a New CLI Command

## Location

CLI commands live in `packages/synergy/src/cli/cmd/`. Each command is a separate file exporting a yargs command module.

## Pattern

```ts
import type { CommandModule } from "yargs"

export default {
  command: ["$0", "my-command"],
  aliases: ["mc"],
  describe: "what this command does",
  builder: (yargs) =>
    yargs.option("flag", {
      type: "string",
      describe: "flag description",
    }),
  handler: async (args) => {
    // Implementation
  },
} satisfies CommandModule
```

## Steps

1. **Create the command file** in `packages/synergy/src/cli/cmd/<name>.ts`
2. **Study existing commands** — look at `server.ts`, `send.ts`, `status.ts` for patterns
3. **Register the command** — add it to the CLI router in `packages/synergy/src/cli/index.ts` or the appropriate parent command
4. **Handle errors gracefully** — use try/catch, provide helpful error messages
5. **Add `--help` text** — use `describe` and option descriptions for self-documenting CLI
6. **Test manually** — run via `bun run packages/synergy/src/cli/index.ts <command>`
7. **Update docs** — add to README.md Common Commands section if user-facing

## Conventions

- Use kebab-case for command names: `my-command` not `myCommand`
- Provide short aliases when practical
- Print minimal output by default, verbose with `--verbose` flag
- Use `process.exit(1)` for error exits
- Import UI helpers from `packages/synergy/src/cli/ui.ts` for consistent formatting

## Key files

- `packages/synergy/src/cli/index.ts` — CLI entry point and routing
- `packages/synergy/src/cli/cmd/` — all command implementations
- `packages/synergy/src/cli/ui.ts` — shared UI helpers (colors, formatting)
