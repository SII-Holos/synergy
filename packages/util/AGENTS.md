# Shared Utility Rules

This published package owns dependency-light primitives shared across runtime, SDK, plugins, UI, and protocol packages.

- Do not import App, Desktop, or core-runtime implementation into this package. Keep utilities deterministic, side-effect free unless explicitly named, and safe in every declared runtime.
- Preserve public export paths and Bun/types/import resolution. Prefer small domain-neutral functions and schemas over moving product ownership into a generic helper.
- The `tool-timeout` export owns the one definition of the tool-timeout observation (`ToolTimeoutSource`, `ToolTimeoutMetadata`) shared by the runtime producer and the shared UI consumer. It lives here because `ui` may not import runtime-private modules and `util` is the only package both already depend on. Keep it type-only and keep the `*Ms` field names: the object is persisted on tool parts, so renaming strands the observation on stored history. Seconds are the unit at the agent- and human-facing boundary, not here.
- The public `runtime-startup` export owns the versioned startup-record schema and bounded framing constants. Keep payloads aggregate-only; CLI emission, Desktop presentation and waiting policy belong to their consumers. Verify schema edge cases with `bun test test/runtime-startup.test.ts` and run the core migration/CLI and Desktop startup consumer tests when changing this export.
- Shared capability metadata is a cross-package security contract. Changes require `change-execution-boundaries` and synchronization with enforcement, plugin permissions/consent, and tests.
- Infer types from Zod schemas, preserve structured errors, and test edge cases at the utility boundary. Avoid environment or filesystem assumptions in portable helpers.

Run `bun run typecheck`, `bun test`, and `bun run build`, affected consumer tests, and root `bun run package:check` plus `bun run quality:quick`.

`asset-reference` owns portable immutable Asset ID/reference validation and MIME/extension mapping. Runtime storage and UI resolution share this contract; it never reads files or selects a server. Verify it with `bun test test/asset-reference.test.ts` and affected Asset/Markdown tests.

`attachment-presentation` owns the shared attachment presentation schema and evidence/deliverable classification used by runtime, plugins and UI. Purpose is independent of model input policy; absent purpose defaults to a deliverable. Legacy metadata conversion belongs to the Session migration, not this portable contract. Verify the Harness attachment presentation/migration and UI attachment tests when changing it.

`reasoning-item` owns portable provider-scoped reasoning identity for canonical Part summaries and UI grouping. Preserve ambiguous/missing-identity rejection and keep encrypted content out of derived keys.

`terminal` owns explicit Bun terminal output primitives; product branding stays in CLI. `cli-command` supplies yargs definition typing without loading the CLI parser.

`atomic-file` and `io-retry` own durable file promotion and bounded transient filesystem retries. Installation bootstrap uses these without loading Harness. Keep shared directory synchronization and cross-process installation locks consistent with persisted-state recovery.

`process-group` owns process-group anchoring, cancellation and bounded Windows taskkill. Shell execution and pre-bootstrap package installation use the same primitive; never replace whole-tree cleanup with killing only the direct child.

`installed-launcher` validates generation pins and builds subprocess argument arrays from explicitly supplied environment metadata. It performs no discovery, import or shell evaluation.

`native-assets` resolves platform resources from an explicit owning module. Linux ABI selection distinguishes musl and glibc; native resource packages remain separate from portable JavaScript.

`markdown-assets` owns bounded managed-reference extraction using the Markdown lexer and deterministic attachment suppression. It performs no resource loading; callers decide which prose is the final answer and which files are deliverables. Verify parser boundaries, summary limits and both virtual and hydrated conversation placement.

`resource-reference` owns the portable target parser, Workspace origin and location schemas. It never selects a current Workspace or probes files. Use it for every Markdown/resource ingress; ownership validation and opening belong to the host. Verify `test/resource-reference.test.ts` with affected message, composer and resource-opening tests.

`render-artifact` owns [visual schemas](../../docs/architecture/visual-results.md); `json-value` validates nested JSON.
