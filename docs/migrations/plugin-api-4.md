# Plugin API 4 Migration

Plugin API 4 extends the generated-manifest and host-runtime contract without a Plugin API 3 compatibility adapter. Plugin packages must be rebuilt with the API 4 public package and plugin-kit before installation or update.

## Plugin Authors

Rebuild and validate the plugin with `@ericsanchezok/synergy-plugin@4` and `@ericsanchezok/synergy-plugin-kit@4`.

API 4 adds or tightens these contracts:

- trusted UI ownership is derived from the public contribution schemas, including nested text-action presentation components;
- manifest and permissions hashes are the canonical update-consent evidence, so any generated manifest or capability change may require approval again;
- detached `context.agent.start()` calls are Scope-owned, deliver one terminal result through `agent.call.after`, and are cancelled when their Scope runtime is disposed;
- contribution health is keyed as `<kind>:<id>`, allowing different contribution kinds to reuse a plugin-local ID without overwriting each other;
- selected-text contributions use the host selection provenance contract, including `code` selections with non-editable `other` origin;
- plugin Tool renderers are isolated per card and fall back to the host Tool renderer when the trusted component throws.

Do not preserve or synthesize old hashes, bare contribution-health IDs, or detached calls across a Scope disposal. Treat a refreshed approval review as authoritative and retry only after explicit Scope activation.

Build, validate, and pack again:

```bash
synergy-plugin build
synergy-plugin validate --runtime-discovery
synergy-plugin pack
```

## Package Export Contract

The repository workspace resolves TypeScript declarations directly from `./src/*.ts` so clean-checkout typechecking does not depend on prebuilt `dist` files. Release packaging rewrites those declaration exports to `./dist/*.d.ts`; published packages contain only built output.

Plugin projects should consume the published package and must not depend on repository-only source paths.

## Synergy Host Data

API 4 does not add a persisted host-data backfill. Contribution health and detached Agent calls are transient runtime state. Existing installations retain plugin settings, enablement, lockfile entries, and approvals, but an update is re-evaluated against the current manifest and permissions hashes and may require approval again.

Old plugin archives are incompatible and must be replaced by newly built API 4 packages.
