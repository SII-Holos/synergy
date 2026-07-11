# Synergy Plugin Platform

Plugins extend the Synergy runtime and Web workbench through declared, versioned contracts. A plugin can contribute runtime tools, agents, skills, commands, MCP servers, provider behavior, hooks, configuration, and UI surfaces without importing private Synergy modules.

The platform has four parts:

- `@ericsanchezok/synergy-plugin` — public runtime, manifest, tool, hook, policy, and UI types
- `@ericsanchezok/synergy-plugin-kit` / `synergy-plugin` — standalone create, validate, develop, build, test, sign, pack, and publish commands
- the Synergy runtime — discovery, install, approval, isolation, bridge, lifecycle, and health
- the Web plugin host — versioned Solid UI contribution loading

Normal plugin development does not require a Synergy source checkout.

## Start Here

| Task                                                                                     | Document                                                           |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Create, run, validate, and package a plugin                                              | [Getting started](getting-started.md)                              |
| Define `plugin.json`                                                                     | [Manifest reference](manifest.md)                                  |
| Understand source trust, approval, runtime isolation, hooks, and host bridge             | [Runtime and permissions](runtime-and-permissions.md)              |
| Build tools, internal helpers, delegated tasks, attachments, and display behavior        | [Tools and delegation](tools-and-delegation.md)                    |
| Add workbench panels, navigation, settings, renderers, slots, themes, icons, or commands | [UI contributions](ui-contributions.md)                            |
| Publish to the official or local marketplace                                             | [Marketplace and registry](marketplace.md)                         |
| Review a plugin before distribution                                                      | [Security checklist](security.md)                                  |
| Look up TypeScript APIs and hooks                                                        | [`packages/plugin` SDK reference](../../packages/plugin/README.md) |

## Canonical Identity

One plugin ID must be used everywhere:

- runtime descriptor `id`
- `plugin.json.name`
- configuration and auth namespace
- lockfile entry
- approval record
- registry entry and signature payload

An identity mismatch fails validation or loading. Changing the ID creates a new installation and trust boundary rather than renaming an existing approval.

## Extension Contract

The source plugin exports a `PluginDescriptor` with `id` and `init()`. The manifest declares everything the host must know before importing that runtime: identity, compatibility, permissions, contributions, lifecycle commands, runtime preference, and limits.

Validation compares runtime discovery with the manifest. Packaging produces a normalized manifest, compiled runtime entry, permission summary, integrity map, and declared assets. Installation evaluates source provenance, signature/integrity, risk, requested capabilities, consent, and runtime isolation before enabling the plugin.

Runtime tool calls and bridge operations still cross Synergy's execution boundary. UI contributions load only when `permissions.ui` is declared and their requested UI API version is compatible with the host.

## Current Contribution Families

- runtime tools and tool display metadata
- skills and agents
- local or remote MCP servers
- CLI and configured Synergy commands
- plugin-scoped configuration schema and defaults
- provider auth and provider runtime/catalog profiles
- event, chat, permission, tool, session, Cortex, Agenda, Note, Library, and experimental hooks
- tool and part renderers
- side/bottom workbench panels and navigation pages
- settings sections, message/composer slots, UI commands, themes, and icons

The manifest and public SDK are authoritative for exact fields.
