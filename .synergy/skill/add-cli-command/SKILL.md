---
name: add-cli-command
description: Add or modify a Synergy CLI command, command group, positional, option, alias, help text, exit behavior, or root command registration under packages/synergy/src/cli. Use for installed synergy CLI work; do not use for the repository-only bun dev orchestrator.
---

# Add a CLI Command

## Discover the Contract

1. Read [CLI reference](../../../docs/reference/cli.md) and inspect `packages/synergy/src/index.ts`.
2. Locate the nearest command with the same shape: local operation, server-attached operation, nested command group, streaming output, or destructive confirmation.
3. Decide whether the behavior belongs in the installed `synergy` CLI or the source-only `bun dev` orchestrator. Edit `script/dev.ts` only for the latter.

## Implement

1. Write a failing behavior test first when adding behavior or fixing a bug.
2. Add or update a named command in `packages/synergy/src/cli/cmd/` with `cmd()`. Match neighboring yargs builder, positional, alias, and output patterns rather than imposing a parallel style.
3. Keep domain logic in its owning module. Let the command parse input, establish Scope or server attachment, call the domain API, format output, and set an appropriate exit status.
4. Give every command, positional, and option useful help text. Support structured output when the adjacent command family already does.
5. Register a root command in `packages/synergy/src/index.ts`; register a nested command in its owning command-group builder.
6. Use generated SDK/server helpers for attached commands where the family already does. Preserve auth, directory/Scope, timeout, and error semantics.
7. Regenerate the SDK with `./script/generate.ts` only if an API route or OpenAPI-visible schema changed.

## Verify

```bash
bun run packages/synergy/src/index.ts <command> --help
```

Then run the narrow CLI/domain test from `packages/synergy`, followed by:

```bash
bun run typecheck
bun run quality:quick
```

For startup, daemon, port, Web, Desktop, auth, or data movement changes, test through an isolated `SYNERGY_HOME`; use the `develop-synergy` skill and never disrupt the active instance.

## Synchronize Documentation

Update [CLI reference](../../../docs/reference/cli.md) for user-visible syntax or behavior. Also review `README.md`, configuration/storage references, affected help text, and `.synergy/command/` workflows. Keep migration history outside the current CLI reference.

## Handoff

Report the registered command path, domain API called, failure/exit behavior, manual invocation, tests, SDK generation status, and documentation updated.
