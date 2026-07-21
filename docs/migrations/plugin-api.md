# Plugin API 3 Migration

Plugin API 3 replaced the pre-release descriptor/manifest/runtime architecture in one cut. Synergy does not load old plugin packages through an adapter.

## Plugin Authors

Rebuild the plugin around one default `definePlugin()` export:

- move identity, metadata, capabilities, contributions, and handlers into the definition;
- replace nested contribution maps with one flat contribution list;
- replace the old permission tree with top-level Host Service capabilities and per-contribution `requires`;
- replace mutable hooks with handlers for host-declared observer, transform, or guard points;
- replace direct client/server access with `PluginInvocationContext` Host Services;
- expose UI workflows through operations and events;
- migrate complex UI to an approved trusted Solid component receiving `PluginSurfaceContext`;
- remove any source `plugin.json` and rebuild with plugin-kit;
- package dependencies into the build output instead of requesting install-time dependency installation.

Build, validate, and pack again:

```bash
synergy-plugin build
synergy-plugin validate --runtime-discovery
synergy-plugin pack
```

Old archives are incompatible and must be replaced by a newly built package.

## Synergy Host Data

The `plugin-api-3-catalog` migration converts resolvable catalog entries to the current lockfile, records unresolvable old packages as `reinstallRequired`, preserves identifiable plugin settings and enablement through the owning config domain, clears runtime cache, and marks all old approvals `needsApproval` with no inferred capabilities.

Sessions, messages, tasks, workspaces, and other non-plugin data are unchanged. Plugin-owned business data is not inspected or migrated by Synergy.

After migration, only the current manifest reader, runtime protocol, dispatcher, contribution registry, UI host, and approval model remain active.
