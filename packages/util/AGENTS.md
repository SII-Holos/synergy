# Shared Utility Rules

This published package owns dependency-light primitives shared across runtime, SDK, plugins, UI, and protocol packages.

- Do not import App, Desktop, or core-runtime implementation into this package. Keep utilities deterministic, side-effect free unless explicitly named, and safe in every declared runtime.
- Preserve public export paths and Bun/types/import resolution. Prefer small domain-neutral functions and schemas over moving product ownership into a generic helper.
- Shared capability metadata is a cross-package security contract. Changes require `change-execution-boundaries` and synchronization with enforcement, plugin permissions/consent, and tests.
- Infer types from Zod schemas, preserve structured errors, and test edge cases at the utility boundary. Avoid environment or filesystem assumptions in portable helpers.

Run `bun run typecheck` and `bun run build`, affected consumer tests, and root `bun run package:check` plus `bun run quality:quick`.
