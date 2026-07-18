# Synergy Documentation

This documentation describes the current Synergy product and implementation. Code remains the authority when behavior changes; documentation should state the supported current model directly and keep historical narratives inside dedicated migration or research material.

## Start Here

| Reader or task                   | Start with                                                                                  |
| -------------------------------- | ------------------------------------------------------------------------------------------- |
| Understand the product           | [Product overview](product/overview.md)                                                     |
| Install or operate Synergy       | [CLI reference](reference/cli.md) and [configuration reference](reference/configuration.md) |
| Understand the runtime           | [Architecture overview](architecture/README.md)                                             |
| Contribute to the repository     | [Development reference](reference/development.md) and [CONTRIBUTING.md](../CONTRIBUTING.md) |
| Change frontend colors or themes | [Frontend themes and color](reference/frontend-theming.md)                                  |
| Build a plugin                   | [Plugin documentation](plugins/README.md)                                                   |
| Modify Synergy with an AI agent  | [AGENTS.md](../AGENTS.md)                                                                   |

## Product

Product documents explain what users work with and how the major capabilities relate.

- [Product overview](product/overview.md) — positioning, product objects, surfaces, and durable principles
- [Workspaces and sessions](product/workspaces-and-sessions.md) — Scope, projects, sessions, agents, tools, history, and Browser ownership
- [Agents, tools, skills, and commands](product/agents-and-tools.md) — catalogs, external agents, exposure, customization, and ACP
- [Workflows](product/workflows.md) — direct work, Plan, Blueprints, BlueprintLoop, Light Loop, Lattice, delegation, and compaction
- [Knowledge](product/knowledge.md) — Library memories and experiences, Notes, Blueprints, recall, and search
- [Activity and statistics](product/activity-and-statistics.md) — usage, tokens, costs, agents, tools, code changes, trends, and derived-data freshness
- [Automation](product/automation.md) — Agenda triggers, session modes, delivery, recovery, and failure behavior
- [Connections](product/connections.md) — providers, MCP, Channels, Email, Holos, Synergy Link, and plugins
- [Browser workspace](product/browser.md) — one-page session ownership, native and remote presentation, safety, and interaction
- [Web product contract](../packages/app/PRODUCT.md) — durable interaction, visual, and accessibility rules

## Architecture

Architecture documents define current invariants, ownership boundaries, and the flows maintainers must preserve.

- [Architecture overview](architecture/README.md)
- [Runtime and Scope](architecture/runtime-and-scope.md)
- [Workspace and files](architecture/workspace-and-files.md)
- [Sessions and messages](architecture/session-and-messages.md)
- [LLM loop and compaction](architecture/llm-loop.md)
- [Frontend data sync](architecture/frontend-data-sync.md)
- [Frontend localization](architecture/localization.md)
- [Execution boundaries](architecture/execution-boundaries.md)
- [Cortex and delegated work](architecture/cortex.md)
- [Workflow engine](architecture/workflows.md)
- [Browser runtime](architecture/browser-runtime.md)

## Reference

Reference documents answer exact operational and repository questions without repeating the product narrative.

- [CLI](reference/cli.md)
- [Configuration](reference/configuration.md)
- [Storage and paths](reference/storage-and-paths.md)
- [Package map](reference/packages.md)
- [Development](reference/development.md)
- [Frontend themes and color](reference/frontend-theming.md)

## Plugins

The [plugin documentation](plugins/README.md) covers the external authoring surface and the runtime's extension trust model:

- getting started and development kit
- manifest and contribution reference
- generated manifests, capabilities, runtime generations, trust, and approval
- tools, agents, commands, MCP, and product UI contributions
- validation, signing, packaging, marketplace publishing, and security

Historical plugin upgrade instructions live under [migrations](migrations/README.md), outside the current authoring contract.

The package-level SDK reference remains in [`packages/plugin`](../packages/plugin/README.md).

## Operations

- [Operations index](operations/README.md)
- [Open-source quality](operations/open-source-quality.md) — local checks, CI, package validation, and contributor scenarios
- [Desktop release](operations/desktop-release.md) — packaging, signing, publishing, updating, and recovery
- [Performance observability](operations/performance-observability.md) — metrics, traces, storage, APIs, and performance tooling

## Research and Migration History

Research documents record investigations and measurements; they are not current product contracts. Migration documents explain historical state transitions only when that history remains operationally useful.

- [Research index](research/README.md)
- [Migration history](migrations/README.md)

## Documentation Ownership

- `README.md` is the concise repository and product entry point.
- `docs/product/` owns user-facing concepts and flows.
- `packages/app/PRODUCT.md` owns durable Web interaction and visual principles.
- `docs/architecture/` owns implementation invariants and subsystem boundaries.
- `docs/reference/` owns exact commands, configuration, paths, packages, and development procedures.
- `docs/plugins/` owns the public plugin platform documentation.
- `docs/operations/` owns release, quality, and observability runbooks.
- `docs/research/` and `docs/migrations/` are the only homes for investigation and historical narratives.
- `AGENTS.md` files contain repository rules for coding agents rather than general product explanation.
- `.synergy/skill/` contains executable repository workflows and links to the canonical documents above.
