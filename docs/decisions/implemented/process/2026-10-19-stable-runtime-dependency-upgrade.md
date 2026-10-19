# Decision Record: Stable runtime and dependency upgrade

Status: implemented

## Problem

Runtime, UI, model SDK and native helper versions had diverged. Updating manifests alone can pass compilation while breaking lazy runtime resources, generated APIs, patched virtual lists or language diagnostics. A coordinated upgrade needs evidence at those integration points and explicit exceptions for incompatible releases.

## Decision

The repository pins Bun 1.4.3 and Electron 44.9.0, with Playwright 1.64.1, electron-builder 26.17.0, TypeScript 7.0.2, AI SDK 7, Vite 8, Babel 8, Lingui 6 and the corresponding stable direct dependency updates in the workspace manifests and lockfile. Native helper build inputs use Rust 1.99.1. macOS packaging requires macOS 13 or later. Platform binary, helper patch, release inventory and CI action inputs are upgraded together.

The TypeScript compiler uses its native implementation. Tools that consume the JavaScript compiler API explicitly depend on `@typescript/typescript6` 6.0.2. Project language services select the project's TypeScript package: native TypeScript 7 uses stdio LSP with pull diagnostics, while earlier projects retain their tsserver adapter. LSP processes continue through the existing Environment resource and Workspace lifecycle owners.

AI SDK adapters use provider specification v4, asynchronous message conversion, tagged file inputs and the new token-detail fields. Recorded historical usage remains readable; new reasoning totals are not counted twice. Tests exercise generated requests, image receipts, stream boundaries, compaction and retained history. Tree-sitter loads the WASM filename published by its installed release.

Generator and virtual-list upgrades retain the working versions: `hono-openapi` 1.1.2 and patched `@hey-api/openapi-ts` 0.88.1 preserve the generated SDK's public methods and payload schemas; patched Virtua 0.42.3 preserves measured initialization, stable item identity and history restoration. Hono OpenAPI 1.5 and Hey API 0.99 produced incompatible generated contracts during verification. Virtua 0.53.5 does not expose the patched measurement interfaces. These are explicit compatibility holds, not a claim that every dependency is the newest release. Each can advance when its replacement passes the existing public behavior tests and generated-contract checks.

Cua SDK and its checksum-pinned worker advance together to 0.36.0. The native patch follows the upstream snapshot API and source workspace layout. The host explicitly requests structured elements alongside the tree and sends snapshot-bound element tokens; the new compact default otherwise removes targets needed for semantic action admission. Background and foreground input require separate execution evidence; concurrent human input invalidates a foreground comparison and does not establish an upstream regression. Background delivery remains a preference: a route that briefly activates the target cannot count as an interference-free pass.

Launcher upgrades derive first-party roots from the canonical preset catalog, including Desktop's separately selected Browser runtime. A duplicated upgrade list omitted that module and caused a bundled upgrade to seek an old version outside its sealed seed. Offline upgrade tests retain third-party pins and old worker generations while advancing every release-aligned selected root. A matching bundled seed remains sufficient without registry access.

Managed launchers announce installed-module preparation before verifying or upgrading a sealed generation. Desktop applies its existing five-minute stage inactivity budget to this work, then follows Runtime initialization and readiness. Repeating a stage cannot extend the deadline. This keeps a large offline module copy from being killed by the thirty-second unannounced-start deadline without accepting health before the Runtime is ready.

Upstream constraints are documented by the [AI SDK 7 migration guide](https://ai-sdk.dev/docs/migration-guides/migration-guide-7-0), [TypeScript native port](https://github.com/microsoft/typescript-go), [LSP 3.17 diagnostics](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#textDocument_diagnostic) and [Electron breaking changes](https://www.electronjs.org/docs/latest/breaking-changes). Retained local dependency adaptations have their authoritative provenance in [the patch inventory](../../../../patches/README.md).

## Alternatives considered

**Upgrade every version without exception.** Public generator output and virtual-list behavior are product interfaces; version freshness does not justify changing them accidentally.

**Retain the entire old toolchain after one incompatibility.** This gives up unrelated runtime updates. Compatibility holds are limited to the demonstrated coupled group or explicit compiler-API consumer.

**Accept compilation as sufficient evidence.** Compilation missed both a renamed runtime WASM asset and a changed language-server protocol. Managed Desktop, real model calls and native helper checks exercise those late-bound paths.

## Consequences

Major versions require adapter changes and patch rebasing. Marked 18 keeps consumed character references available to the source-position renderer, preserves indented-code newlines and excludes whitespace-only tokens from visible block bounds. Fuzzysort object searches supply an explicit key. Kobalte patches follow the resolved Utils version and release dialog accessibility hiding on teardown. Test transforms use Babel 8 preset objects, and browser font descriptors are checked in Chromium rather than an incomplete DOM emulator. TypeScript compiler and compiler-API packages intentionally have different versions. Older macOS installations fall outside the new Desktop support floor. Linux watcher builders retain their glibc/musl deployment constraints; locally cross-compiled artifacts do not establish native runtime acceptance on other operating systems.

Local acceptance includes copied historical data, isolated managed Desktop startup and restart, readable old conversations, new tasks and Worktrees, real model tool execution and Browser operations. Provider credentials, private data and raw acceptance receipts stay outside repository documentation. Release signing, distribution and the full platform/provider matrix remain release/CI responsibilities.
