# Desktop Package Rules

These rules apply to the Electron shell. Root `AGENTS.md` and the Web/runtime package rules still apply to code reached through Desktop.

Load `change-browser-runtime` for native Browser or Browser-host/WebRTC work and `develop-synergy` for manual Desktop verification. Read [Desktop release](../../docs/operations/desktop-release.md) before packaging, signing, updating, or changing release assets.

## Keep Desktop a Host

- Desktop owns Electron lifecycle, the managed/local server process, preload IPC, native dialogs/clipboard/shell, window state/chrome, updates, and native Browser presentation. It does not own a parallel session, permission, or Browser page model.
- Keep `contextIsolation: true`, `nodeIntegration: false`, and renderer sandboxing. Expose narrow typed preload methods; validate every IPC payload in the main process and keep privileged Electron objects out of the renderer.
- Preserve production URL/navigation, permission, external-link, download, and window-creation policy. Do not replace blocked navigation with a permissive fallback.
- Keep external-server development mode and packaged managed-server mode distinct. Never stop or reuse the runtime carrying the current task.
- Native Browser uses `WebContentsView` and the shared Browser command/page contract. Remote Browser-host mode uses the shared WebRTC/data-channel path; neither creates alternate tabs or screenshot-stream presentation.
- Browser content sessions may grant Chromium local-network and loopback-network permissions, but unrelated media, device, location, and filesystem permissions remain denied. Do not duplicate Chromium network policy in Electron or the server gateway.
- Keep update channel, checksum, release asset, bundled runtime, and server shutdown behavior aligned. Test packaging inputs rather than assuming source files are included.

## Verify

Run `bun run typecheck` and the focused test under `test/`, then `bun run desktop:test`. For Browser changes, run `test:runtime` and the relevant core/Web tests. Exercise the affected external or managed mode through an isolated home, and finish with root `bun run quality:quick`.

Update the Browser architecture, Web product contract, or Desktop release runbook when their durable behavior changes.
