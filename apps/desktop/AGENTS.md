# Desktop Package Rules

Root `AGENTS.md` and Web/runtime rules also apply.

Load `change-browser-runtime` for native Browser pages/profiles/popups and `develop-synergy` for Desktop verification. Read [Desktop release](../../docs/operations/desktop-release.md) before packaging, signing, updates or release changes.

## Keep Desktop a Host

- Desktop owns Electron/server lifecycle, preload IPC, native dialogs/clipboard/shell, window chrome, updates, Browser presentation and the private Computer driver. It owns no parallel Session, permission or page model.
- Keep `contextIsolation: true`, `nodeIntegration: false`, and renderer sandboxing. Expose narrow typed preload methods; validate every IPC payload in the main process and keep privileged Electron objects out of the renderer.
- Preserve production URL/navigation, permission, external-link, download, and window-creation policy. Do not replace blocked navigation with a permissive fallback.
- HTML fullscreen requires the current trusted App main-frame document.
- Keep external-server and packaged managed modes distinct.
- Member profiles reuse `DesktopServerManager`; main owns device/Home, credentials and supervisors. Verify member-supervisor, member-registry and member-browsers tests.
- Main selects folders and rechecks project execution/member identity after selection. Return strict summaries and opaque revisions; verify project-binding and organization IPC tests.
- Private reads reuse the typed Runtime dispatcher. Recheck creator, member and binding around replies; verify member-read, content-download, transfer-deadline and organization IPC tests. Native saves retain idle deadlines, integrity and atomic publication.
- Typed command streams reuse canonical input/reply schemas and byte limits. Bind each transfer to its document, account and connection; verify offsets, digest, cancellation and exact generated dispatch in organization IPC tests.
- Native Browser creates one real `WebContentsView` per page and adopts native popups with their opener. Profile resources are shared by reference count; page commands never change human tab selection. The broker requires a local server.
- Member brokers use main-owned Runtime keys and independent data contexts; keep protocol identities canonical.
- Browser content sessions may grant Chromium local-network and loopback-network permissions, but unrelated media, device, location, and filesystem permissions remain denied. Do not duplicate Chromium network policy in Electron or the server gateway.
- Keep update channel, checksum, release asset, bundled runtime, and server shutdown behavior aligned. Test packaging inputs rather than assuming source files are included.
- `src/power-save.ts` aggregates personal/member activity into the only `powerSaveBlocker` assertion. Read each server's `/global/activity`; renderer requests only re-checks. Release on every quit path and keep the setting opt-in.

## Verify

Main owns organization credentials; follow `change-server-api`. Verify owner suites and isolated `SYNERGY_DESKTOP_RUNTIME_TEST=1 bun test test/organization-native.test.ts`.

Run `bun run desktop:test`, affected `test/` suites, and root `bun run quality:quick`. Verify affected modes in an isolated home; Browser changes additionally require `test:runtime` and core/Web tests.

Background Browser: `SYNERGY_DESKTOP_RUNTIME_TEST=1 SYNERGY_DESKTOP_BACKGROUND_TEST=1 bun test test/browser-runtime-smoke.test.ts`; visible/focus fixtures skip and remain unverified.

Startup changes require `SYNERGY_DESKTOP_RUNTIME_TEST=1 bun test test/startup-progress-runtime.test.ts` and an isolated managed upgrade exceeding the health deadline. Use `SYNERGY_DESKTOP_BACKGROUND_TEST=1` for hidden fixtures without focus requests.

Update the Browser architecture, Web product contract, or Desktop release runbook when their durable behavior changes.

For native Computer changes, load `change-computer-runtime` and read [Native Computer Use](../../docs/architecture/computer-use.md); run `bun test test/computer/*.test.ts`, `test:computer-native` and `test:computer-acceptance` in an isolated Desktop. `bun run test:coverage` includes both top-level and Computer suites and is the root coverage manifest entry point.

For keep-awake changes, run `bun test test/power-save.test.ts` and macOS `SYNERGY_DESKTOP_RUNTIME_TEST=1 bun test test/power-save-native.test.ts`. Also verify an isolated Desktop's assertion while a task runs, after window close and after quitting (`pmset -g assertions`).

Packaging consumes the shared release `runtime-layout.cjs` contract and copies the sealed module seed as a unit. Preserve its complete inventory and reject unlisted payloads before copying.

Sign children, reseal both inventories, then sign the app; never mutate afterward. Preserve notarization. Run `bun test test/mac-signing.test.ts test/runtime-seal.test.ts test/packaging.test.ts` on macOS. See the [decision](../../docs/decisions/implemented/bug-fix/2026-10-25-seal-runtime-between-child-and-app-signatures.md).

Keep `test/fixture/branding.js.txt` unchanged. Reassess the detector override when osx-sign upgrades.

Portable application receipts bind release version, artifact hash, executable and actual native signing identity. Publish the application package only after all supported targets have receipts and their uploaded bytes match.
