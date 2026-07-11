# Synergy Plugin Platform

Synergy Plugin API 3 has one architecture path:

1. A source module exports `definePlugin()`.
2. plugin-kit validates the flat contribution list and generates `plugin.json`, runtime bundle, UI bundle, hashes, and generation.
3. Installation reads generated data without importing plugin code, verifies integrity, and asks for capability and trusted-UI approval.
4. `ContributionAdapterRegistry` registers declarations with host subsystems.
5. `PluginRuntimeRegistry` lazily starts one active runtime generation per plugin.
6. The unified dispatcher invokes operations, tools, hooks, auth, and lifecycle handlers with a fresh invocation context.
7. The UI host supplies one `PluginSurfaceContext` to every trusted component.

Operations are finite request/response calls. They default to UI-only and enter the public SDK only with `expose: ["ui", "sdk"]`. Long-running domain work returns the plugin's own handle and publishes declared events; Synergy does not impose a generic Job or plugin database.

Hooks use host-declared points with observer, transform, or guard semantics. Ordering is priority, plugin ID, then contribution ID. A handler failure degrades that contribution unless the hook point explicitly requires failure propagation.

External runtime mode is `process`; built-ins may use `inProcess`. There is no worker mode, plugin iframe tier, or OS sandbox claim in the plugin API.

Upgrade and uninstall handlers are lifecycle contributions. Upgrade runs on the prepared new generation before activation; failure leaves the old generation active. Forced uninstall skips cleanup and may leave plugin-owned data.

See [`packages/plugin/README.md`](../../packages/plugin/README.md) for the authoring API.
