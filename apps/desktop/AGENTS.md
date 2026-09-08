# Desktop Package Rules

These rules apply to the Electron shell. Root `AGENTS.md` and the Web/runtime package rules still apply to code reached through Desktop.

Load `change-browser-runtime` for native Browser or Browser-host/WebRTC work and `develop-synergy` for manual Desktop verification. Read [Desktop release](../../docs/operations/desktop-release.md) before packaging, signing, updating, or changing release assets.

## Keep Desktop a Host

- Desktop owns Electron lifecycle, the managed/local server process, preload IPC, native dialogs/clipboard/shell, window state/chrome, updates, native Browser presentation, and the private native Computer driver. It does not own a parallel session, permission, or Browser page model.
- Keep `contextIsolation: true`, `nodeIntegration: false`, and renderer sandboxing. Expose narrow typed preload methods; validate every IPC payload in the main process and keep privileged Electron objects out of the renderer.
- Preserve production URL/navigation, permission, external-link, download, and window-creation policy. Do not replace blocked navigation with a permissive fallback.
- Keep external-server development mode and packaged managed-server mode distinct. Never stop or reuse the runtime carrying the current task.
- Native Browser uses `WebContentsView` and the shared Browser command/page contract. Remote Browser-host mode uses the shared WebRTC/data-channel path; neither creates alternate tabs or screenshot-stream presentation.
- Browser content sessions may grant Chromium local-network and loopback-network permissions, but unrelated media, device, location, and filesystem permissions remain denied. Do not duplicate Chromium network policy in Electron or the server gateway.
- Keep update channel, checksum, release asset, bundled runtime, and server shutdown behavior aligned. Test packaging inputs rather than assuming source files are included.
- Browser Host packages only its bundled Electron entry and independent manifest from `build/browser-host-app`. Exclude node_modules explicitly because the Bun dependency collector can fall back to the Desktop manifest even when the staged manifest has no dependencies. The Browser Host afterPack hook rejects any extra ASAR entry or unpacked payload; keep this exact closure separate from the Desktop Computer driver and full runtime.

## Verify

Run `bun run typecheck` and the focused test under `test/`, then `bun run desktop:test`. For Browser changes, run `test:runtime` and the relevant core/Web tests. Exercise the affected external or managed mode through an isolated home, and finish with root `bun run quality:quick`.

Update the Browser architecture, Web product contract, or Desktop release runbook when their durable behavior changes.

For native Computer changes, read [Native Computer Use](../../docs/architecture/computer-use.md); run `bun test test/computer/*.test.ts` and verify exact-window background actions in an isolated Desktop. `bun run test:coverage` includes both top-level and Computer suites and is the root coverage manifest entry point.
