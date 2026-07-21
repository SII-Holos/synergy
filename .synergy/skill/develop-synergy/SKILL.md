---
name: develop-synergy
description: Run and test a source checkout of Synergy in an isolated second runtime without stopping or modifying the active Synergy instance. Use for source development, end-to-end verification, alternate branches/worktrees, bun dev web or desktop, managed Desktop testing, port conflicts, and SYNERGY_HOME isolation.
---

# Develop Synergy Safely

## Protect the Active Runtime

Never stop, restart, signal, or reuse the `SYNERGY_HOME` of the Synergy instance carrying the current task. Do not run `synergy stop`, broad `kill`/`pkill`, or modify its data/lock files.

Read [Development reference](../../../docs/reference/development.md) before choosing a mode.

## Prepare an Isolated Home

1. Choose a dedicated parent directory and explicit free ports. Check listeners with `lsof -nP -iTCP -sTCP:LISTEN` or the platform equivalent; do not assume `4097` and `3001` are free.
2. Create the required `.synergy` parent and copy configuration:

```bash
DEV_HOME=/tmp/synergy-dev-<short-name>
mkdir -p "$DEV_HOME/.synergy"
cp -R ~/.synergy/config "$DEV_HOME/.synergy/config"
```

3. Copying configuration preserves provider settings but does not copy the separate credential store. Do not copy sessions, daemon state, locks, logs, cache, or Library data. Seed only the fixture credentials a test requires inside the isolated home; never copy or overwrite the live credential store implicitly.
4. Run `bun dev prepare` once when dependencies, generated SDK, Web dist, plugin SDK, or sandbox helper are missing.

## Choose the Smallest Mode

```bash
SYNERGY_HOME="$DEV_HOME" bun dev server --port 4097
SYNERGY_HOME="$DEV_HOME" bun dev app --attach http://127.0.0.1:4097 --port 3001
SYNERGY_HOME="$DEV_HOME" bun dev web --server-port 4097 --app-port 3001
SYNERGY_HOME="$DEV_HOME" bun dev desktop --server-port 4097 --app-port 3001
SYNERGY_HOME="$DEV_HOME" bun dev desktop --managed --server-port 4097 --app-port 3001
SYNERGY_HOME="$DEV_HOME" bun dev send "test request"
```

Development modes bind to loopback by default. To expose an isolated Web stack deliberately, bind both the source server and Vite app with the shared hostname flag:

```bash
SYNERGY_HOME="$DEV_HOME" bun dev web --hostname 0.0.0.0 --server-port 4097 --app-port 3001
```

Use `server` for backend/CLI work, `web` for normal full-stack work, `desktop` for Electron-native behavior, and `desktop --managed` for the production-style managed-server path. Managed mode rebuilds the Web distribution before launch.

Development process lifecycle is owned by the root orchestrator. Both serial build-and-run workflows and parallel workflows tag their descendants at spawn time so cleanup can recover nested process groups even after package wrappers exit. A managed Desktop server arms parent-process liveness monitoring before startup becomes healthy and shuts down if its Electron parent disappears, because forced application termination cannot run Electron quit handlers.

## Preserve Desktop Renderer Lifecycle

Route main-process broadcasts for the application renderer through `DesktopRendererDelivery`. A live `BrowserWindow` or `WebContents` does not prove that its current main frame can receive IPC during startup, document navigation, reload, renderer exit, or shutdown.

- Restore delivery only from the trusted `desktop.startup.appReady` handshake; let main-frame navigation, renderer exit, and destruction invalidate it.
- Use `sendLatest()` for replaceable snapshots such as window, theme, and update state; use `enqueue()` for one-shot messages such as deep links; use `send()` for transient events that should be dropped while the renderer is unavailable.
- Keep startup-overlay updates on the overlay's own `WebContentsView`; it is not the application renderer.
- Cover pre-ready, main-frame reload, post-ready convergence, destroyed/detached frame, and renderer-exit behavior before running an isolated Desktop cold-start and reload check.
- Keep renderer window-state broadcasts disabled on macOS. Native fullscreen moves the window across Spaces asynchronously and can emit unstable focus/fullscreen transitions; macOS uses native chrome and should query state explicitly when needed.

## Verify and Diagnose

1. Confirm health on the selected server port before opening dependent clients.
2. Reproduce the behavior with a new isolated Scope/session. Record only redacted IDs and project-relative evidence in shareable output.
3. Use `SYNERGY_HOME="$DEV_HOME" synergy logs --dev`, `status --verbose`, or `diagnostics` against the isolated environment. Never inspect the main runtime by accident.
4. Restart only the isolated process when server or Desktop main-process code changes; Vite handles Web hot reload.
5. Run narrow automated tests and `bun run quality:quick` independently of the manual instance.

## Clean Up

Terminate only PIDs launched for this isolated home. Verify the PID/port before signaling it. Remove the isolated directory only after its processes have exited and only when no evidence is needed.

## Handoff

Report the isolated home label without exposing secrets, chosen mode and ports, reproduction steps, observed result, logs/trace filters used, automated checks, and whether cleanup completed.
