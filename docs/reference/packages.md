# Package Map

The root `package.json` selects workspace packages. Each package manifest owns its name, dependencies and public exports. The [architecture ownership map](../architecture/README.md#ownership-map) describes the complete directory layout and responsibilities.

## Runtime entry points

`@ericsanchezok/synergy-harness` exposes programmatic execution and lifecycle APIs. `@ericsanchezok/synergy-local-runtime` registers the default local host and provides `openLocalRuntime`. The single CLI implementation lives in `packages/cli`; `packages/presets` invokes that same CLI with full product capabilities. Both entry points use the command name `synergy`, and `createRuntimeCli()` derives available commands from the selected components.

`packages/server` owns HTTP/WS transport and core routes. Domain packages contribute their own routes, tools and commands. Full OpenAPI generation includes those contributions, and Web clients use `@ericsanchezok/synergy-sdk`.

`apps/web` owns Web interaction. `apps/desktop` owns Electron, native Browser/Computer hosting and managed runtime processes. Desktop Browser Host is a second entry and independently packaged artifact. Shared protocol packages remain separate from these native implementations.

The [secret-detection package](../../packages/secret-detection/README.md) owns the asynchronous detection interface, regex baseline and offline quality/performance evaluation. Harness owns its detector source, Vault and masking integration.

## Optional agent integrations

MCP, LSP, Formatter, ACP, External Agents, Link Client and Code Tools are separate workspace packages: `mcp`, `lsp`, `formatter`, `acp`, `external-agents`, `link-client` and `code-tools`. Each owns its public exports, tests and configuration registration. LSP and Formatter can register independently; complete composition orders Formatter before LSP. Their existing domain configuration files and field names stay stable.

## Embedded component composition

`@ericsanchezok/synergy-agent-runtime` provides `openAgentRuntime({ home, components })` for Bun. `home` is the data directory itself, and the returned handle exposes `client({ directory })`, `run()`, `close()` and asynchronous disposal. It includes Local Runtime and the process plugin host; optional domains come only from the explicit component list. See the [Agent Runtime package](../../packages/agent-runtime/README.md) for an embedding example.

Each optional package exports a factory from `./component`. Factories declare identity, API version, dependency versions, optional ordering, role-specific worker entries and lazy CLI/HTTP adapters. A missing dependency, incompatible version, duplicate identity or cycle rejects the composition before storage opens. Registration and service state belong to each Runtime, including when two runtimes reuse the same component objects. The HTTP host combines independent route owners while preserving Scope middleware, authentication and operation IDs.

Plugin Host owns plugin execution and installation. Plugin Kit is an explicit authoring dependency; the full preset selects its authoring commands through the same component adapter used by downstream hosts. Domain CLI modules use shared terminal/command primitives and Local Runtime's network/Scope adapters, without depending on the CLI application.

## Package builds

Run `bun script/build-workspace.ts packages/harness` from the repository root to build its importable modules. `bun script/pack-workspace.ts packages/cli .artifacts/packages` builds and packs the CLI workspace dependency closure. Archives contain compiled module exports and normal dependency versions. Packing compiles the existing HTTP SDK without regenerating the complete product API; run the root generator explicitly after API changes. Core archives do not include optional Browser, Library, MCP or UI packages.

Harness and Local Runtime publish platform-independent modules. Their optional `synergy-native-<platform>-<architecture>[-<libc>]` dependencies supply verified SQLite, PTY, watcher and sandbox resources. macOS uses the packaged universal SQLite engine without Homebrew; Linux glibc and musl have distinct package identities. Pass `--target=linux-x64`, `--target=linux-arm64-musl` or `--target=win32-x64` to select a target; Linux and Windows builds require matching helper assets through `SYNERGY_SANDBOX_ASSETS_DIR`. The build verifies the binary format and records its digest in the platform package. Missing required assets fail the build. Darwin uses the operating system sandbox.

`bun script/package-install-check.ts .artifacts/packages` installs the archives through a temporary local registry into a fresh directory outside the repository and runs the same CLI artifact contracts used for compiled binaries. It does not publish packages. After packing `packages/presets` into the same archive directory, `bun script/runtime-composition-check.ts .artifacts/packages` verifies independent Bun core, MCP, LSP, HTTP, Browser, Library, Notes and full backend compositions. `bun script/installation-composition-check.ts packages/presets/dist/modules-packages` uses the complete release archive set to verify core installation, component changes, company presets, Web and the installed Node SDK. Package installation cannot rely on workspace symlinks or test preload dependencies.

Full product and Desktop distribution use the existing release workflow and the typed catalog in `script/release/shared/packages.ts`. The existing `@ericsanchezok/synergy` product package retains the complete product; `@ericsanchezok/synergy-cli` installs the minimal CLI. All public workspace modules, platform native packages and core/full/Web/Desktop selections publish from the same dependency-ordered release graph. Desktop application metadata publishes after the portable artifacts are signed, hashed and uploaded.

## Public extension APIs

Plugin authors compile against `packages/plugin`; `packages/plugin-kit` provides plugin development commands. Host internals live in `packages/plugin-host`. Link transport and host implementations use the shared `packages/synergy-link-protocol` contracts.

The HTTP SDK is generated from the complete Server API. Run `./script/generate.ts` after route/schema changes. A reduced server composition does not remove methods from the full public SDK.

Use `client.global.capabilities()` to inspect the active component selection. Node.js hosts use an explicit managed process or attach to an existing service; see [Embedding](embedding.md) for version, home, authentication and shutdown ownership.

## Validation

`bun run deps:check` checks package imports, exports and dependency directions. `bun run monorepo:check` checks manifest consistency. `bun run package:check` validates existing public packages and their TypeScript resolution. Independent runtime archives additionally use the install check above. Tests and fixtures follow their domain owner; full composition tests live in `packages/presets/test`.

See [Development](development.md) and [Open-source quality](../operations/open-source-quality.md) for repository commands and CI checks.

The authoritative selection catalog is `packages/plugin-host/src/installation/catalog.ts`: core supplies execution and plugin hosting, full adds backend components, HTTP and Plugin Kit, Web adds its UI payload, and Desktop adds its application shell. Each first-party component publishes its factory entry, version and requirements under `package.json#synergy`.

Installation metadata is published through `synergy-plugin/package`. Plugin Host owns source resolution and verified immutable module generations; `atomic-file` and `io-retry` are public Util primitives used by both startup verification and existing plugin recovery.

## Installation commands

`synergy install <spec...>` accepts built-in selections, npm and Git sources, local directories and archives. `synergy list --json` reports package identities, versions, explicit selections and dependency owners alongside legacy plugins. `synergy update [name...]` updates explicit selections; omitting names selects all roots. `synergy remove <name...>` removes a root and dependencies that no retained selection needs. Removing an indirect dependency reports the package that selects it. Existing `plugin add`, `plugin update` and `plugin remove` commands route managed packages through the same installer.

Components and applications require host-code trust for the complete resolved generation, including retained packages. Interactive install/update displays that selection; unattended install/update uses `--trust-host-code` whenever the resulting installation contains components or applications, even if the requested change only updates a plugin. Removal preserves trust for retained code. API4 plugins retain their separate capability grants. `--approve-plugin <id>` approves the displayed grant for that plugin, and host-code trust cannot substitute for it. Legacy API4 manifests and flat plugin archives remain accepted without evaluating their entrypoints during resolution.

The CLI package bin enters a dependency-light launcher that verifies a complete immutable module generation before importing Harness. Its first npm launch snapshots only the installed dependency closure, including required peers and present optional dependencies, without another registry request or code evaluation. Workers re-enter the launcher with the foreground generation and digest, including when another installation becomes active. Source embedding continues to use explicit component lists. Installation changes apply on the next start; running processes retain their existing modules. A committed but interrupted plugin activation resumes through storage recovery or `synergy install --resume`. Further activation waits until that journal completes, and API4 configuration, approvals and lifecycle delivery remain owned by the existing plugin transactions.

Application packages select a portable archive for the host platform. Downloads require HTTPS and the published checksum; macOS additionally verifies the Apple signing team and notarization, and signed Windows distributions verify Authenticode and publisher identity. An unsigned Windows distribution explicitly declares checksum-only verification, following the existing release signing-continuity policy. `synergy desktop` opens the verified native shell, or the owning Desktop application when invoked through its bundled CLI. Application payloads stay in immutable installation generations, separate from the running app and its user data.

Compiled releases use the same modules as npm installs: a thin launcher plus a sealed offline seed. Optional packages own their runtime resources; the full/Web/Desktop selections use the same component factories and worker pins. The outer release inventory and inner generation inventory verify the complete tree before it executes.

Updating the launcher upgrades its core and version-aligned first-party roots together. Explicit local sources and third-party pins remain selected and must satisfy the new host version. Compatible bundled selections upgrade offline; other selections use their retained package lock. A failed upgrade leaves the active generation intact, and old workers keep their original pins. `synergy remove <name>` runs against the active generation before upgrading, so an incompatible extension can be removed without editing installation files. The next ordinary launch retries the upgrade. Pending API4 activation must finish with `synergy install --resume` before another generation can replace it. Existing homes retain the full Web backend on first adoption; replacing a minimal launcher with a full distribution does not silently expand an existing core selection.

Component-only changes do not require database maintenance, and package listing inspects legacy plugins read-only. API4 activation retains exclusive maintenance ownership. Source runtimes use explicit component composition; installed-package commands reject source execution before resolving packages, while `plugin add` retains the local API4 development workflow. Application preparation reuses unchanged verified payloads and refuses changes to an established signing identity.
