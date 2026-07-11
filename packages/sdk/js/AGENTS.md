# TypeScript SDK Rules

This package contains generated OpenAPI clients plus narrow handwritten client/server helpers. Load `change-server-api` for every route or schema change.

- Treat `src/gen/` as generated output. Never hand-edit it; change server OpenAPI metadata/schema and run `./script/generate.ts` from the repository root.
- Keep `createSynergyClient()` responsible for client construction and the established directory/Scope headers. Preserve caller-provided fetch, headers, auth, errors, base URL, and asset behavior.
- Keep handwritten server/start helpers small and public-runtime safe. Do not import private core implementation into this published package.
- Inspect generated diffs for operation IDs, reusable schema names, optionality, error responses, and accidental churn. Update every first-party consumer when a generated method changes.
- Preserve Bun/types/import export conditions and built package resolution.

Run `bun run typecheck` and `bun run build`, the affected route/client tests, and root `bun run package:check` plus `bun run quality:quick`.
