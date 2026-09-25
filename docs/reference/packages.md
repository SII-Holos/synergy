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

The Harness archive declares its build target OS; Local Runtime also declares its CPU. macOS Harness archives carry the verified universal SQLite engine in `dist/libsqlite3.dylib`, so consumers do not need Homebrew. Pass `--target=linux-x64`, `--target=linux-arm64-musl` or `--target=win32-x64` to select a target; Linux and Windows builds require matching helper assets through `SYNERGY_SANDBOX_ASSETS_DIR`. The build verifies the binary format and embeds its digest alongside the packaged helper. Missing required assets fail the build. Darwin uses the operating system sandbox.

`bun script/package-install-check.ts .artifacts/packages` installs the archives through a temporary local registry into a fresh directory outside the repository and runs the same CLI artifact contracts used for compiled binaries. It does not publish packages. After packing `packages/presets` into the same archive directory, `bun script/runtime-composition-check.ts .artifacts/packages` verifies the CLI core, Browser, Library, Notes and full server compositions. Package installation cannot rely on workspace symlinks or test preload dependencies.

Full product and Desktop distribution use the existing release workflow and the typed catalog in `script/release/shared/packages.ts`. Source directory changes do not rename the public product package, executable or installed resources.

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

Components and applications require host-code trust. Interactive installation displays the resolved selection; unattended installation uses `--trust-host-code`. API4 plugins retain their separate capability grants. `--approve-plugin <id>` approves the displayed grant for that plugin, and host-code trust cannot substitute for it. Legacy API4 manifests and flat plugin archives remain accepted without evaluating their entrypoints during resolution.

The CLI launcher verifies a complete immutable module generation before importing Harness. Workers re-enter the launcher with the foreground generation and digest, including when another installation becomes active. Source embedding continues to use explicit component lists. Installation changes apply on the next start; running processes retain their existing modules. A committed but interrupted plugin activation resumes through storage recovery or `synergy install --resume`. Further activation waits until that journal completes, and API4 configuration, approvals and lifecycle delivery remain owned by the existing plugin transactions.

Application packages select a portable archive for the host platform. Downloads require HTTPS and the published checksum; macOS additionally verifies the Apple signing team and notarization, and Windows verifies Authenticode and publisher identity. `synergy desktop` opens the verified native shell. Application payloads stay in immutable installation generations, separate from the running app and its user data.
