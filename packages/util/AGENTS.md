# Shared Utility Rules

This published package owns dependency-light primitives shared across runtime, SDK, plugins, UI, and protocol packages.

- Do not import App, Desktop, or core-runtime implementation into this package. Keep utilities deterministic, side-effect free unless explicitly named, and safe in every declared runtime.
- Preserve public export paths and Bun/types/import resolution. Prefer small domain-neutral functions and schemas over moving product ownership into a generic helper.
- The public `runtime-startup` export owns the versioned startup-record schema and bounded framing constants. Keep payloads aggregate-only; CLI emission, Desktop presentation and waiting policy belong to their consumers. Verify schema edge cases with `bun test test/runtime-startup.test.ts` and run the core migration/CLI and Desktop startup consumer tests when changing this export.
- Shared capability metadata is a cross-package security contract. Changes require `change-execution-boundaries` and synchronization with enforcement, plugin permissions/consent, and tests.
- Infer types from Zod schemas, preserve structured errors, and test edge cases at the utility boundary. Avoid environment or filesystem assumptions in portable helpers.

Run `bun run typecheck`, `bun test`, and `bun run build`, affected consumer tests, and root `bun run package:check` plus `bun run quality:quick`.
