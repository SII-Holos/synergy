# Synergy Agent Guidelines

## Build/Test Commands

- **Install**: `bun install`
- **Run**: `bun run --conditions=browser ./src/index.ts`
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
- **Migrations**: Put versioned schema/data upgrades in the dedicated migration modules and runner. Fresh-install table creation can live with database initialization, but legacy upgrades, backfills, and data rewrites must not be scattered through runtime or request code.
- **API Client**: When modifying server endpoints in `packages/synergy/src/server/server.ts`, run `./script/generate.ts` to regenerate the SDK.

### Sandbox Architecture

The sandbox system lives in `packages/synergy/src/sandbox/`:

```
sandbox/
  backend.ts       — Unified dispatch: types, platform detection, macOS Seatbelt,
                     Linux bwrap (separate function), execution, cleanup
  helper/          — Windows sandbox helper (Rust native binary)
    Cargo.toml
    src/config.rs  — JSON config struct for the helper (stdin or --config)
```

**Design principles:**

- `prepareWrapper()` for macOS wraps commands with `sandbox-exec -f <profile>` using a generated Seatbelt `.sb` temp profile. Uses `allow-default` then denies user-data roots and re-allows the active workspace.
- `prepareLinuxWrapper()` is a standalone function for Linux bwrap. It never uses `--ro-bind /`. Runtime roots, workspace, and controlled tmp are bound individually.
- On Windows, `platformInfo()` currently reports the platform as unavailable. The Rust helper binary (`helper/`) implements a restricted-token sandbox with Job Object isolation. The `prepareWrapper()` dispatch does not yet route to it.

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

1. Add a `prepare<Nix>Wrapper()` function in `backend.ts` following the same signature as `prepareLinuxWrapper()`.
2. Wire it into `prepareWrapper()` dispatch (or keep separate for now — the Windows helper is not yet wired).
3. Update `platformInfo()` for availability detection.
4. Add denial patterns to `enforcement/sandbox-detector.ts` if the new backend produces distinct error messages.

**Windows helper binary (Rust):**

The helper lives in `sandbox/helper/` and reads its config as JSON from stdin:

```rust
pub struct SandboxConfig {
    pub level: String,         // "restricted-token" | "elevated"
    pub mode: String,          // "read_only" | "workspace_write"
    pub workspace: String,
    pub execution_cwd: String,
    pub writable_roots: Vec<String>,
    pub read_roots: Vec<String>,
    pub protected_paths: Vec<String>,
    pub data_deny_roots: Vec<String>,
    pub command: String,
    pub args: Vec<String>,
}
```

The helper uses `windows-sys` crate for native Win32 APIs. Cross-compile from non-Windows with:

```bash
rustup target add x86_64-pc-windows-msvc
cargo install --locked cargo-xwin
cargo xwin build --target x86_64-pc-windows-msvc --release
```
