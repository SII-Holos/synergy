---
name: change-browser-runtime
description: Add, modify, or review Synergy Browser ownership, persisted page state, BrowserControl commands, routes and events, navigation policy, Desktop WebContentsView presentation, remote Browser host/WebRTC signaling and input, downloads, or Browser workspace UI. Use across packages/synergy/src/browser, Browser server routes/tools, packages/desktop, and packages/app Browser surfaces.
---

# Change the Browser Runtime

## Trace the Shared Contract

1. Read [Browser runtime](../../../docs/architecture/browser-runtime.md), `packages/synergy/AGENTS.md`, `packages/app/AGENTS.md`, and `packages/desktop/AGENTS.md`.
2. Identify the owner key and whether the behavior is canonical runtime state, a `BrowserControl` command/result, a read-only event, presentation selection, host signaling, or Web UI state.
3. Trace the change across Browser schemas/runtime, control and route handlers, persistence and reaping, Browser tools, Desktop host/view handlers, remote host/WebRTC data channel, generated SDK where applicable, and the Web Browser store/surface.
4. Load `change-server-api` for route/schema changes, `develop-frontend` for product UI, `change-persistence` for saved Browser state, and `change-execution-boundaries` for navigation or evaluation policy.

## Preserve Ownership and Presentation

1. Keep one Browser session per owner and at most one canonical page per Browser session. Do not introduce a tab adapter or merge host-only pages into canonical state.
2. Keep page creation lazy. State reads, event subscriptions, signaling, and host attachment may ensure the owner session exists but must not create a page; ordinary first navigation owns page creation.
3. Keep `POST /browser/control` command/response behavior separate from the read-only `/browser/events` stream. Return explicit page-missing, host-pending, retryable, and terminal errors.
4. Preserve Desktop-native `WebContentsView` and remote WebRTC/data-channel presentation as peer modes over the same owner/page/control contract. Do not add iframe, screenshot-stream, pseudo-tab, or hidden fallback pages.
5. Keep pointer, keyboard, text, IME/paste, and viewport coordinates normalized across native and remote presentation. Preserve CSS width/height semantics and coalesced pending viewport behavior.
6. Keep Chromium responsible for webpage network security. The gateway owns loopback binding, owner authentication, connection limits, forwarding, and revoke cleanup; do not add IP-range classification, Fake-IP exceptions, localhost port lists, or DNS policy. Preserve protocol checks, workspace file containment, hidden/project metadata exclusions, download filtering, and sensitive-header redaction.
7. Treat the server-provided session-state `ownerKey` as canonical. Route directories select a route; they never derive native tickets, profiles, broker pages, or view attachment identity.
8. Dispose live Browser state on session archive/delete and global shutdown; preserve profile, storage-state, download, annotation, and restored page-ID ownership.

## Verify

1. Add a failing test for the public invariant before implementation. Cover page creation, owner isolation, control/event separation, host transitions, policy, persistence, or cleanup at the owning layer.
2. Run the focused Browser route/runtime/tool tests, Desktop Browser/view tests, and Web store/component tests affected by the change.
3. Typecheck `packages/synergy`, `packages/desktop`, and `packages/app`; regenerate the SDK only for OpenAPI-visible changes.
4. Exercise both relevant presentations in an isolated runtime. A native-only check does not prove WebRTC behavior, and a remote check does not prove Desktop bounds/lifecycle.
5. Finish with `bun run quality:quick` and update the architecture/product contract when ownership, lifecycle, policy, transport, or presentation changes.

## Handoff

Report owner/page effects, command and event changes, persistence and cleanup, navigation/enforcement behavior, native and remote presentation coverage, generated contracts, tests, and manual runtime evidence.
