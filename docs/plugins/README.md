# Synergy Plugin Platform

Synergy Plugin API 4 has one authoring source and one host path. A plugin exports `definePlugin()` with a flat contribution list. plugin-kit validates that definition and generates the installable manifest and bundles. Synergy reads generated metadata before it imports executable code, records approval, registers contributions, and starts one runtime generation lazily when an executable contribution is invoked.

Plugin API 4 is the stable compatibility baseline. Future Synergy releases keep loading valid API4 artifacts without requiring authors to rebuild or users to reinstall. The `@ericsanchezok/synergy-plugin` and `@ericsanchezok/synergy-plugin-kit` package versions follow the Synergy product release version, while generated artifacts keep `apiVersion: "4.0"`. Later package releases may add optional fields, contribution kinds, and Host Services without changing the API family. Existing fields are not removed, renamed, narrowed, or given new semantics; deprecated APIs retain their implementation and types. Only `experimental.*` surfaces are outside this guarantee.

## Start Here

| Task                                                                                      | Document                                                       |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Create, build, validate, run, and package a plugin                                        | [Getting started](getting-started.md)                          |
| Understand the generated `plugin.json` contract                                           | [Generated manifest](manifest.md)                              |
| Understand capabilities, Host Services, runtime generations, hooks, events, and lifecycle | [Runtime and capabilities](runtime-and-permissions.md)         |
| Contribute agent-callable tools, delegation, BlueprintLoop, and LightLoop workflows       | [Tools and delegation](tools-and-delegation.md)                |
| Add workbench, navigation, renderer, settings, theme, icon, or slot contributions         | [UI contributions](ui-contributions.md)                        |
| Browse, publish, install, update, or remove packages                                      | [Marketplace](marketplace.md)                                  |
| Review trust and operational boundaries                                                   | [Security](security.md)                                        |
| Look up TypeScript APIs                                                                   | [`packages/plugin` reference](../../packages/plugin/README.md) |

## One Contract

The source definition owns plugin identity, capabilities, declarations, and handlers. Authors do not maintain a source `plugin.json`, a separate handler map, or a permission tree. `plugin.json` is build output.

Every contribution has a plugin-local unique `id` and a discriminating `kind`. Executable contributions are operations, tools, hooks, auth providers, and lifecycle handlers. Agents, skills, MCP servers, and UI metadata are declarative. Host adapters register each kind with its owning Synergy subsystem.

Declarative contributions extend the corresponding host subsystem; they do not create plugin-local copies of it. In particular, Agent contributions enter Synergy's Agent registry, delegated Cortex tasks enter native child Sessions, BlueprintLoop and LightLoop workflow delegation enters the corresponding controller, tools enter the host Tool Registry, and settings enter the host Settings renderer.

The plugin ID remains identical across the definition, generated manifest, registry entry, lockfile, approval, runtime generation, asset URLs, and UI surface IDs. A mismatch is an error, not an alias.

The loader first reads a small version/compatibility envelope and then uses the frozen `PluginManifestV4` decoder. A future manifest family enters the current runtime through its own boundary adapter rather than scattered loader branches. Plugin API 3 is archival and does not load; an unsupported API family and an insufficient Synergy version produce distinct errors before plugin code is imported.

## Runtime and Data Ownership

External plugins run in a separate process for crash, timeout, and cleanup isolation. Trusted built-ins may run in process. There is no plugin worker mode, iframe tier, or claim that the process boundary is an OS security sandbox.

One active `pluginId + version + generation` runtime is shared by every Scope that enables the plugin. Scope, Session, actor, cancellation, logger, events, and capability-gated Host Services are injected into each invocation. Plugins never receive a raw Synergy client, server URL, or token.

Synergy stores installation metadata, approval, per-Scope enablement, declarative settings, and plugin credentials. A plugin owns its business data, schema, concurrency, backup, upgrade, and deletion policy.

## UI Model

[UI API 6](ui-contributions.md) versions trusted frontend presentation independently from Backend Plugin API 4. Components receive one `{ context }` entry with typed domain services, generated plugin data, owned overlays and explicit lifetimes. Shells replace workbench/page presentation while existing host controllers retain state; structured Skins provide fonts and materials independently from semantic-color themes. Plugin Kit validates and packages the complete UI resource graph, and the host rejects incompatible UI before execution while retaining compatible backend contributions.

### Migrating executable UI from UI API 5 to 6

UI API 6 is a deliberate versioned break, not a compatibility shim: no deprecated member, alias, default value, or retained enum value carries the old vocabulary. Upgrade `@ericsanchezok/synergy-plugin` and `@ericsanchezok/synergy-plugin-kit`, rebuild, and ship a manifest that declares `artifacts.ui.apiVersion: "6.0"`. Do not hand-edit the generated manifest to claim a version — compilation, export validation, CSS transformation, and the complete resource graph are required, and `plugin-kit` writes the version from `PLUGIN_UI_API_VERSION`.

One vocabulary changed. Session status replaces `recovering` with `paused`: `status()` now yields `paused` carrying `{ reason, description?, since }` with `reason` one of `aborted`, `failed`, `interrupted`, or `workflow`. A paused session is stopped and is **not** working, so a plugin that treated `recovering` as progress must render `paused` as a distinct stop state; a plugin that already ignored it needs no change. `BlueprintLoopInfo.status` in the blueprint context drops `waiting`, leaving `armed | running | auditing | completed | failed | cancelled`, because BlueprintLoop no longer owns a pause state.

An incompatible UI version is rejected at host validation, before module evaluation, with the reason stated: a plugin declaring UI API 5 on a UI API 6 host fails with `Plugin <id> requires UI API 5.0 but host is 6.0. Rebuild the plugin for the current UI API.` An artifact with no declared `ui.apiVersion` is identified as UI 4 and rejected the same way, and the host compares majors rather than falling through to a default branch. Only the executable UI is refused: the plugin's backend tools, operations, and declarative settings keep loading, and a backend-only plugin is unaffected.
