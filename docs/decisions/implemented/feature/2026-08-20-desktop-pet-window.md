# Decision Record: Desktop pet window with Synergy state awareness

Status: implemented

## Problem

Users wanted a desktop companion on the Synergy Desktop shell: a transparent, always-on-top animated character that reflects Synergy runtime state (idle / working / completed / error), supports drag and click interaction, and can later use AI-generated sprite sheets (8x7 magenta-keyed sprite sheets from the `openai-image-gen` tool). The plugin system can only contribute host-rendered surfaces inside the app window and cannot create system-level transparent topmost windows, so the pet must live in the Electron shell.

## Decision

Add a desktop pet to `packages/desktop` as a dedicated Electron window managed by the main process:

- **`pet-window.ts`** — `DesktopPetWindow` creates a `BrowserWindow` with `transparent: true`, `frame: false`, `alwaysOnTop: true`, `skipTaskbar: true`, `resizable: false`, sandboxed renderer (`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, narrow preload bridge). It subscribes to the Synergy event stream (`GET /event?stream=delta`) through `pet-sse.ts`, feeds events into a pure mood state machine (`pet-state.ts`), and pushes `pet:state` / `pet:settings` / `pet:sprite` to the renderer. Drag/poke intents arrive over typed IPC (`pet.poke` / `pet.dragBy` / `pet.setDragging` / `pet.getState`) and are sender-checked against the pet window's own `webContents`.
- **`pet-state.ts`** — pure `PetStateMachine` mapping bus events to moods (`idle` / `working` / `happy` / `celebrate` / `angry` / `sleepy` / `dragging`): `session.updated` busy/working → working; `session.completion` → celebrate; `session.error` → angry; idle timeout → sleepy; poke → happy; dragging overrides; transient moods expire.
- **`pet-settings.ts`** — versioned `desktop-pet.json` persisted in `userData` (mirrors `zoom-state.ts`), with `enabled`, `spritePath`, `width`/`height`, `position`, `idleTimeoutMs`, `frameMs`.
- **`pet-sprite.ts`** — validates a local 8:7 sprite sheet (PNG/JPEG/WebP header dimension parsing, no full decoder) and builds a base64 data URL for the sandboxed renderer; invalid sheets fall back to a CSS-only blob.
- **`pet-page.ts`** + `pet-preload.ts` — inline HTML document with a strict CSP (`default-src 'none'`, `img-src data:`, `script-src 'unsafe-inline'`), canvas sprite animation, drag/poke interaction, and a typed preload bridge exposing only the pet API.
- **`main.ts`** — `initializePetWindow()` after `ensureMainWindow()`, `petWindow?.setServerUrl(url)` on server restart, `petWindow?.stop()` during `before-quit`, and IPC handlers forwarding to `handleIpc`.
- **Build** — `desktop:build` also bundles `src/pet-preload.ts` → `dist/pet-preload.cjs`.
- **Tests** — `test/pet-state.test.ts`, `test/pet-settings.test.ts`, `test/pet-sprite.test.ts`, `test/pet-page.test.ts`, `test/pet-window.test.ts` (electron mock + injected SSE fetch); `MockElectronWindow` gained position/bounds/alwaysOnTop/skipTaskbar/show methods.

The renderer is sandboxed and loads only a `data:` document; it never receives the server URL or a raw SDK client. The SSE connection is made by the main process, which already owns the server URL via `DesktopServerManager`.

## Alternatives considered

- **Plugin-provided pet** — rejected: the plugin API contributes only host-rendered surfaces inside the app window; there is no system-level transparent window contract.
- **Separate pet process / standalone package** — rejected: would duplicate server discovery, event subscription, and lifecycle wiring already owned by the desktop shell; the pet is a shell feature.
- **Renderer-side SSE subscription** — rejected: the sandboxed renderer has no server URL/token and no network permission; the main process owns the connection and forwards typed state.
- **GIF or video animation** — rejected: sprite sheet is the target asset format from the AI-generation prompt (8x7 magenta-keyed) and is frame-precise; CSS fallback covers the no-sprite case.
- **Full image decoder dependency for validation** — rejected: header dimension parsing (PNG/JPEG/WebP) is sufficient to reject unusable sheets without adding a native dependency.

## Consequences

- The desktop shell gains a transparent topmost pet window that reflects Synergy session activity in real time, with drag and click interaction and persisted position/settings.
- The feature is desktop-only; Web and plugin surfaces are untouched.
- A new `desktop-pet.json` userData file is introduced; settings are versioned and fall back to defaults when missing or invalid.
- The pet window is destroyed on quit and its SSE connection is closed; server restarts re-point the subscription.
- AI-generated sprite sheets can be dropped into `spritePath`; the renderer hot-reloads them via `pet:sprite`. Generating sheets through `openai-image-gen` is a follow-up (the tool already supports sprites and custom sizes).
