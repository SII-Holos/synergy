# Plugin API 4 GA Migration

Plugin API 4 is Synergy's long-term stable plugin baseline. Plugin API 3 is not supported by the GA host: its releases may remain in registry history, but they are not default installation candidates and cannot load. An installed API3 plugin keeps its canonical ID so a published API4 release can replace it directly without uninstalling first.

## Author Migration

Upgrade to `@ericsanchezok/synergy-plugin@4` and `@ericsanchezok/synergy-plugin-kit@4`, rebuild the artifact, and set the minimum compatible host when it is newer than the API4 baseline:

```ts
export default definePlugin({
  id: "my-plugin",
  version: "2.0.0",
  description: "Example",
  compatibility: { synergy: ">=3.0.11" },
  capabilities: [],
  contributions: [],
})
```

`apiVersion` remains `"4.0"` across additive SDK 4.x releases. Published stable plugins must not depend on `experimental.*`. The pre-GA system-context hook is now stable as `chat.system.transform`; the host still accepts the experimental spelling in already-built early API4 artifacts.

Build and inspect the new artifact:

```bash
synergy-plugin build
synergy-plugin validate --runtime-discovery
synergy-plugin pack
```

## Compatibility Promise

The host reads a tolerant version/compatibility envelope before strict decoding and executable import. API4 artifacts then pass through the frozen `PluginManifestV4` decoder. Stable API4 fields, contribution kinds, Host Services, hook points, types, and semantics are additive: existing contracts are not deleted, renamed, narrowed, or repurposed. Deprecated stable APIs retain types and implementation.

Future API families use a separate decoder and one boundary adapter. Compatibility branches do not spread through loaders, registries, or Host Services. Runtime IPC is host-owned; `runtime.protocolVersion` is diagnostic provenance and must not be used as a plugin compatibility gate.

CI keeps a first-release API4 artifact fixture and loads it directly with the current host. The fixture is never rebuilt with the current SDK.

## Approval Migration

The plugin migration converts valid API4 v1 approval records into v2 publisher/access grants and drops API3, tampered, or already-invalid approvals. The config migration removes `pluginApprovalPolicy`; marketplace caches are invalidated.

The new grant stores plugin ID, source, signer, structured access, grant hash, approval method, and time. Synergy host upgrades do not change it. Equal or narrower same-publisher updates continue automatically; added/broadened access, unknown constraint changes, or publisher/source changes require a concise confirmation. Manifest hashes remain signature/integrity and review-freshness evidence, not the user authorization key.

Registry v2 removes plugin risk ratings and adds per-version `apiVersion`, `compatibility`, and separate natural-language feature and access summaries. Hosts accept registry v1 and v2 during rollout.
