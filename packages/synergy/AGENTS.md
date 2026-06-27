# Synergy Agent Guidelines

## Build/Test Commands

- **Install**: `bun install`
- **Source dev**: from the repo root, use `bun dev server`, `bun dev web`, or `bun dev desktop`
- **Product CLI smoke**: from this package, use `bun run --conditions=browser ./src/index.ts`
- **Typecheck**: `bun run typecheck`
- **Test**: `bun test` (runs all tests)
- **Single test**: `bun test test/tool/tool.test.ts` (specific test file)

## Code Style

- **Runtime**: Bun with TypeScript ESM modules
- **Imports**: Use relative imports for local modules, named imports preferred
- **Types**: Zod schemas for validation, TypeScript interfaces for structure
- **Naming**: camelCase for variables/functions, PascalCase for classes/namespaces
- **Error handling**: Use Result patterns, avoid throwing exceptions in tools
- **File structure**: Namespace-based organization (e.g., `Tool.define()`, `Session.create()`)

## Architecture

- **Control profiles**: `src/control-profile/` owns user-facing access profiles; `src/enforcement/` owns capability classification and gate decisions; `src/sandbox/` owns OS sandbox backends. Keep these layers separate and avoid reintroducing tool-local boundary checks.

- **Tools**: Implement `Tool.Info` interface with `execute()` method
- **Context**: Pass `sessionID` in tool context, use `App.provide()` for DI
- **Validation**: All inputs validated with Zod schemas
- **Logging**: Use `Log.create({ service: "name" })` pattern
- **Storage**: Use `Storage` namespace for persistence
- **Migrations**: Put versioned schema/data upgrades in the dedicated migration modules and runner. Fresh-install table creation can live with database initialization, but upgrades, backfills, and data rewrites must not be scattered through runtime or request code.
- **API Client**: When modifying server endpoints in `packages/synergy/src/server/server.ts`, run `./script/generate.ts` to regenerate the SDK.
- **Provider framework**: Provider existence comes from the profile/catalog resolver, not directly from `models.dev`. Keep remote catalogs data-only and signature-verified; complex auth, transport, and usage behavior belongs in built-in strategies or explicitly installed plugins.
- **Provider auth**: Keep `openai-codex` as the ChatGPT/Codex OAuth device-code provider. Do not mix it with the `openai` Platform API-key provider or share/write Codex CLI `auth.json` credentials directly. Runtime auth reads the provider auth store at `~/.synergy/data/auth/provider-auth.json`; imported auth files are handled by migrations only.

### Sandbox Architecture

The sandbox system lives in `packages/synergy/src/sandbox/`:

```
sandbox/
  backend.ts       — Unified dispatch + shared execution/cleanup
  macos.ts         — macOS Seatbelt backend
  linux.ts         — Linux helper-backed backend; inline bwrap is debug-only
  helper-linux/    — Linux Rust sandbox helper
  helper/          — Windows Rust sandbox helper (`synergy-sandbox-windows.exe`)
    src/config.rs  — Shared PermissionProfile JSON contract
```

**Design principles:**

- `prepareWrapper()` for macOS wraps commands with `sandbox-exec -f <profile>` using a generated deny-default Seatbelt profile by default; `seatbelt-legacy-allow-default` is explicit opt-out.
- Linux production dispatch uses `synergy-sandbox-linux`; inline bwrap is available only through `backend: "bwrap-inline-debug"`.
- On Windows, `prepareWrapper()` dispatches to `synergy-sandbox-windows.exe` when a verified helper is present. The helper consumes the shared `SynergySandboxPermissionProfile` JSON shape.

**Integration layers:**

| Layer            | File                                  | Role                                                                           |
| ---------------- | ------------------------------------- | ------------------------------------------------------------------------------ |
| Config schema    | `src/config/schema.ts`                | Defines `SandboxConfig` (`enabled`, `fallbackPolicy`)                          |
| Control profile  | `src/control-profile/profiles.ts`     | Resolves sandbox mode per profile (`workspace_write`, `none`, fallback)        |
| Enforcement gate | `src/enforcement/gate.ts`             | Exposes resolved sandbox mode from the active profile                          |
| Tool resolver    | `src/session/tool-resolver.ts`        | Calls `prepareWrapper()` before shell execution, manages fallback policy       |
| Sandbox detector | `src/enforcement/sandbox-detector.ts` | Scans command output for OS-level denial patterns (EACCES, read-only FS, etc.) |
| API route        | `src/server/control-profile-route.ts` | Exposes `/sandbox/status` endpoint for platform availability                   |

**Adding a new backend:**

1. Add or update the platform backend module under `src/sandbox/` and keep dispatch centralized in `backend.ts`.
2. Wire it into `prepareWrapper()` dispatch and `platformInfo()` availability detection.
3. Keep helper-backed platforms on the shared `SynergySandboxPermissionProfile` JSON contract.
4. Add denial patterns to `enforcement/sandbox-detector.ts` if the new backend produces distinct error messages.

**Windows helper binary (Rust):**

The helper lives in `sandbox/helper/`, builds as `synergy-sandbox-windows.exe`,
and consumes the shared `SynergySandboxPermissionProfile` JSON contract used by
the Linux helper. The profile is passed with `--permission-profile <path>` and
the child command follows `--`:

```bash
synergy-sandbox-windows.exe --permission-profile <profile.json> --cwd <workspace> -- <command> <args...>
```

The config shape is:

```rust
pub struct PermissionProfile {
    pub file_system: FileSystemPolicy, // serde rename: "fileSystem"
    pub network: NetworkPolicy,
}
```

The TS backend passes process command/args through argv, not through the
profile JSON. `SandboxConfig` stays focused on file-system and network policy.

The helper uses `windows-sys` crate for native Win32 APIs. Cross-compile from non-Windows with:

```bash
rustup target add x86_64-pc-windows-msvc
cargo install --locked cargo-xwin
cargo xwin build --target x86_64-pc-windows-msvc --release
```

**Bundled bwrap binary:** The Linux sandbox helper can discover a bundled
bwrap binary placed at `helper-linux/bwrap/bwrap` relative to the helper
executable. In CI/release builds, the bwrap binary is placed here during
the packaging step.

To build with bundled bwrap:

1. Obtain a static bwrap binary for the target architecture
2. Place it at `src/sandbox/helper-linux/bwrap/bwrap`
3. The Rust helper will discover it automatically via `bwrap_binary()`

Discovery order (in `bwrap_binary()`):

1. `SYNERGY_BWRAP` environment variable (if set and non-empty)
2. Bundled `bwrap/bwrap` relative to the helper binary's directory
3. `bwrap` from system `PATH` (fallback)
