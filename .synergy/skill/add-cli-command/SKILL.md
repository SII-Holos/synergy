---
name: add-cli-command
description: Add or modify a Synergy CLI command, command group, positional, option, alias, help text, exit behavior, or root command registration under packages/cli/src/cli. Use for installed synergy CLI work; do not use for the repository-only bun dev orchestrator.
---

# Add a CLI Command

## Discover the Contract

1. Read [CLI reference](../../../docs/reference/cli.md), the single parser in `packages/cli/src/main.ts`, and the product command catalog in `packages/product-runtime/src/cli-commands.ts`.
2. Locate the nearest command with the same shape: local operation, server-attached operation, nested command group, streaming output, or destructive confirmation.
3. Decide whether the behavior belongs in the installed `synergy` CLI or the source-only `bun dev` orchestrator. Edit `script/dev.ts` only for the latter.

## Implement

1. Write a failing behavior test first when adding behavior or fixing a bug.
2. Add or update a named yargs command. CLI-dependent owners can use the public CLI `cmd()` helper; Runtime Local and Server must use their own typed command definitions to preserve the dependency direction. Generic commands belong to `packages/cli/src/cli/cmd/`; business commands live under the owning domain’s `cli/` directory and contribute to the product command catalog. Match neighboring yargs builder, positional, alias, and output patterns rather than imposing a parallel style.
3. Keep domain logic in its owning module. Let the command parse input, establish Scope or server attachment, call the domain API, format output, and set an appropriate exit status.
4. Give every command, positional, and option useful help text. Support structured output when the adjacent command family already does.
5. Register a generic root command in the CLI’s core command catalog or a business command in `packages/product-runtime/src/cli-commands.ts`; register nested commands in their owning command-group builder. Preserve the injected runtime factory. Nested product Data commands enter through `runCli({ dataCommands })`; the core Data builder owns path, set-home and snapshots, while Product Runtime contributes pack, merge and move and the root `migrate` alias.
6. Use generated SDK/server helpers for attached commands where the family already does. Preserve auth, directory/Scope, timeout, and error semantics.
7. Regenerate the SDK with `./script/generate.ts` only if an API route or OpenAPI-visible schema changed.

## Command Contract

1. Separate the command kinds: discovery commands (list accounts, projects, or queues), resolve commands (name or URL to a stable ID), read commands (exact object fetch plus a bounded list/search with `--limit` or a cursor), and narrow write commands (one named action each; prefer `--dry-run` or draft mode when the service allows).
2. When the neighboring command family already supports structured output, support stable `--json` output with a documented success shape and machine-readable errors. Never include credentials in error output.
3. Write self-explanatory help text: every command, positional, and option describes its purpose, and `--help` surfaces every major capability.
4. Keep a raw escape hatch only where the family needs one. Never expose only a generic raw request command without high-level verbs.

## Verify

```bash
bun run packages/product-runtime/src/index.ts <command> --help
```

Then run the narrow test from `packages/cli` or the command’s owning business package, followed by:

```bash
bun run typecheck
bun run quality:quick
```

For startup, daemon, port, Web, Desktop, auth, or data movement changes, test through an isolated `SYNERGY_HOME`; use the `develop-synergy` skill and never disrupt the active instance.

## Synchronize Documentation

Run `bun script/gen/gen-cli-reference.ts` to update the generated [CLI reference](../../../docs/reference/cli.md); never hand-edit it. The generator follows both command catalogs, lazy contributions and the product entry’s `dataCommands` injection. Test both core and full help when changing availability or aliases. Also review `README.md`, configuration/storage references, affected help text, and `.synergy/command/` workflows. Keep migration history outside the current CLI reference.

## Handoff

Report the registered command path, domain API called, failure/exit behavior, manual invocation, tests, SDK generation status, and documentation updated.

## Task execution commands

Use the shared `RuntimeHandle` for a local writer and generated SDK methods for attached execution. Subscribe before submission, process interactions during command execution, and always remove signal listeners and drain cancellation in cleanup. Read durable run results instead of treating a session idle event as completion. Keep JSON stdout parseable and report unknown estimates separately from known cost. See [Rollout execution](../../../docs/reference/rollout.md).
