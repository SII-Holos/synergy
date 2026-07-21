# Synergy Plugin Platform

Synergy Plugin API 3 has one authoring source and one host path. A plugin exports `definePlugin()` with a flat contribution list. plugin-kit validates that definition and generates the installable manifest and bundles. Synergy reads generated metadata before it imports executable code, records approval, registers contributions, and starts one runtime generation lazily when an executable contribution is invoked.

## Start Here

| Task                                                                                      | Document                                                       |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Create, build, validate, run, and package a plugin                                        | [Getting started](getting-started.md)                          |
| Understand the generated `plugin.json` contract                                           | [Generated manifest](manifest.md)                              |
| Understand capabilities, Host Services, runtime generations, hooks, events, and lifecycle | [Runtime and capabilities](runtime-and-permissions.md)         |
| Contribute agent-callable tools, delegation, BlueprintLoop, and LightLoop workflows       | [Tools and delegation](tools-and-delegation.md)                |
| Add workbench, navigation, renderer, settings, theme, or icon contributions               | [UI contributions](ui-contributions.md)                        |
| Browse, publish, install, update, or remove packages                                      | [Marketplace](marketplace.md)                                  |
| Review trust and operational boundaries                                                   | [Security](security.md)                                        |
| Look up TypeScript APIs                                                                   | [`packages/plugin` reference](../../packages/plugin/README.md) |

## One Contract

The source definition owns plugin identity, capabilities, declarations, and handlers. Authors do not maintain a source `plugin.json`, a separate handler map, or a permission tree. `plugin.json` is build output.

Every contribution has a plugin-local unique `id` and a discriminating `kind`. Executable contributions are operations, tools, hooks, auth providers, and lifecycle handlers. Agents, skills, MCP servers, and UI metadata are declarative. Host adapters register each kind with its owning Synergy subsystem.

Declarative contributions extend the corresponding host subsystem; they do not create plugin-local copies of it. In particular, Agent contributions enter Synergy's Agent registry, delegated Cortex tasks enter native child Sessions, BlueprintLoop and LightLoop workflow delegation enters the corresponding controller, tools enter the host Tool Registry, and settings enter the host Settings renderer.

The plugin ID remains identical across the definition, generated manifest, registry entry, lockfile, approval, runtime generation, asset URLs, and UI surface IDs. A mismatch is an error, not an alias.

## Runtime and Data Ownership

External plugins run in a separate process for crash, timeout, and cleanup isolation. Trusted built-ins may run in process. There is no plugin worker mode, iframe tier, or claim that the process boundary is an OS security sandbox.

One active `pluginId + version + generation` runtime is shared by every Scope that enables the plugin. Scope, Session, actor, cancellation, logger, events, and capability-gated Host Services are injected into each invocation. Plugins never receive a raw Synergy client, server URL, or token.

Synergy stores installation metadata, approval, per-Scope enablement, declarative settings, and plugin credentials. A plugin owns its business data, schema, concurrency, backup, upgrade, and deletion policy.

## UI Model

Simple metadata is rendered by the host. Complex surfaces are trusted Solid components loaded only after approval. plugin-kit compiles TSX and binds it to the host's shared Solid runtime. Every trusted component receives one `PluginSurfaceContext`; it reads complete state through query operations, sends intent through command operations, and treats events as scoped invalidation or small state-change notifications.
