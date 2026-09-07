# Plugin Kit Rules

This package owns the published `synergy-plugin` authoring CLI. Load `change-plugin-runtime`; public behavior must follow `packages/plugin` and [Plugin documentation](../../docs/plugins/README.md).

- Keep create, typegen, validate, build, dev, preview, test, sign, pack, and marketplace publication commands consistent with `definePlugin()` and the generated manifest.
- Build artifacts must include every declared JS/CSS/SVG asset, externalize the supported Solid runtime paths, preserve deterministic IDs/hashes, and reject source-only or escaping paths.
- Theme JSON must be parsed through `@ericsanchezok/synergy-plugin/theme` in build, validate, and dev for both source and packaged artifacts. Declarative asset hashes participate in generation identity, and a failed dev validation must preserve the last valid generation pointer.
- Validation, signing, and packing must operate on the artifact that will be installed. Do not let dev-mode discovery or local paths weaken production validation.
- Marketplace package and artifact naming uses the manifest ID; the manifest name is display text and may differ.
- Signing and marketplace entry generation must use `@ericsanchezok/synergy-plugin/integrity` for manifest and permissions hashes; do not add a plugin-kit-local hash payload or serializer.
- Runtime discovery must compare packaged executable handler IDs with generated declarations. Publication is an explicit remote action; do not publish during build, validate, test, or pack.
- CLI handlers parse and report; reusable spec, crypto, artifact, and policy logic belongs under `lib/` or the public plugin package.

The public `testing` entry starts isolated production hosts; keep all eight packed templates in the root real-host UI suite. Preview may signal and delete only its own runtime/home, and must settle cancelled builds before cleanup.

Run `bun run typecheck` and `bun run build`, then focused scaffold/build/pack/sign/runtime-discovery tests in `packages/synergy`. Inspect a packed fixture and finish with root `bun run package:check` and `bun run quality:quick`.

Definition inspection runs a fresh Bun CLI subprocess from the author's project; keep its JSON-only descriptor boundary identical for source, published package and compiled host execution. The compiled CLI behavioral test covers `typegen` and scoped CSS builds without sibling implementation files. Type generation formats through explicitly bundled Prettier parsers so it never depends on discovering parser files beside the executable.
