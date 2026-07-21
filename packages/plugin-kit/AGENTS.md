# Plugin Kit Rules

This package owns the published `synergy-plugin` authoring CLI. Load `change-plugin-runtime`; public behavior must follow `packages/plugin` and [Plugin documentation](../../docs/plugins/README.md).

- Keep create, validate, build, dev, test, sign, pack, and marketplace publication commands consistent with `definePlugin()` and the generated manifest.
- Build artifacts must include every declared JS/CSS/SVG asset, externalize the supported Solid runtime paths, preserve deterministic IDs/hashes, and reject source-only or escaping paths.
- Theme JSON must be parsed through `@ericsanchezok/synergy-plugin/theme` in build, validate, and dev for both source and packaged artifacts. Declarative asset hashes participate in generation identity, and a failed dev validation must preserve the last valid generation pointer.
- Validation, signing, and packing must operate on the artifact that will be installed. Do not let dev-mode discovery or local paths weaken production validation.
- Runtime discovery must compare packaged executable handler IDs with generated declarations. Publication is an explicit remote action; do not publish during build, validate, test, or pack.
- CLI handlers parse and report; reusable spec, crypto, artifact, and policy logic belongs under `lib/` or the public plugin package.

Run `bun run typecheck` and `bun run build`, then focused scaffold/build/pack/sign/runtime-discovery tests in `packages/synergy`. Inspect a packed fixture and finish with root `bun run package:check` and `bun run quality:quick`.
