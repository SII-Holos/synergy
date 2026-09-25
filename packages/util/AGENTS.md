# Shared Utility Rules

This published package owns dependency-light primitives shared across runtime, SDK, plugins, UI, and protocol packages.

- Do not import App, Desktop, or core-runtime implementation into this package. Keep utilities deterministic, side-effect free unless explicitly named, and safe in every declared runtime.
- Preserve public export paths and Bun/types/import resolution. Prefer small domain-neutral functions and schemas over moving product ownership into a generic helper.
- The `tool-timeout` export owns the one definition of the tool-timeout observation (`ToolTimeoutSource`, `ToolTimeoutMetadata`) shared by the runtime producer and the shared UI consumer. It lives here because `ui` may not import runtime-private modules and `util` is the only package both already depend on. Keep it type-only and keep the `*Ms` field names: the object is persisted on tool parts, so renaming strands the observation on stored history. Seconds are the unit at the agent- and human-facing boundary, not here.
- The public `runtime-startup` export owns the versioned startup-record schema and bounded framing constants. Keep payloads aggregate-only; CLI emission, Desktop presentation and waiting policy belong to their consumers. Verify schema edge cases with `bun test test/runtime-startup.test.ts` and run the core migration/CLI and Desktop startup consumer tests when changing this export.
- Shared capability metadata is a cross-package security contract. Changes require `change-execution-boundaries` and synchronization with enforcement, plugin permissions/consent, and tests.
- Infer types from Zod schemas, preserve structured errors, and test edge cases at the utility boundary. Avoid environment or filesystem assumptions in portable helpers.

Run `bun run typecheck`, `bun test`, and `bun run build`, affected consumer tests, and root `bun run package:check` plus `bun run quality:quick`.

`terminal` owns explicit Bun terminal output primitives; product branding stays in CLI. `cli-command` supplies yargs definition typing without loading the CLI parser.

`atomic-file` and `io-retry` own durable file promotion and bounded transient filesystem retries. Installation bootstrap uses these without loading Harness. Keep shared directory synchronization and cross-process installation locks consistent with persisted-state recovery.

`process-group` owns process-group anchoring, cancellation and bounded Windows taskkill. Shell execution and pre-bootstrap package installation use the same primitive; never replace whole-tree cleanup with killing only the direct child.

`installed-launcher` validates generation pins and builds subprocess argument arrays from explicitly supplied environment metadata. It performs no discovery, import or shell evaluation.

`native-assets` resolves platform resources from an explicit owning module. Linux ABI selection distinguishes musl and glibc; native resource packages remain separate from portable JavaScript.
