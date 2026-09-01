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
5. Treat managed-local Desktop native presentation as strict. Bootstrap may passively read the owner key without a ticket, but events and controls require fresh owner-bound tickets after `host.registered`; ticket, attach, renderer, and navigation failures remain in native recovery and never fall back to WebRTC. Web and remote Desktop select WebRTC explicitly.
6. Keep pointer, keyboard, text, IME/paste, and viewport coordinates normalized across native and remote presentation. Preserve CSS width/height semantics and coalesced pending viewport behavior.
7. Keep Chromium responsible for webpage network security. The gateway owns loopback binding, owner authentication, connection limits, CONNECT-establishment timeout, forwarding, and revoke cleanup; do not add IP-range classification, Fake-IP exceptions, localhost port lists, or DNS policy. Preserve protocol checks, workspace file containment, hidden/project metadata exclusions, download filtering, and sensitive-header redaction.
8. Treat the server-provided session-state `ownerKey` as canonical. Route directories select a route; they never derive native tickets, profiles, broker pages, or view attachment identity.
9. Keep a native owner/page handle stable while replacing its `WebContentsView`, control, and diagnostics generation. Preserve page/profile/proxy/URL/bounds/visibility/focus identity and page-scoped recovery status. Treat `resume` as the idempotent recovery entry: a healthy page returns state without replacing its generation, an in-flight recovery is awaited, and failed recovery starts a new bounded flight with only the transient budget reset. Rate-limit resume-driven recovery (15s cooldown) so the Agent path cannot loop a failing page; the native Retry control bypasses the cooldown. During `restarting` or `failed`, reject side-effect commands with `browser_native_restarting` or `browser_native_recovery_failed` while allowing `resume`, `close`, `stop`, and safe observations; emit `ready` only after the recovery guard clears, and never replay an action whose execution outcome is unknown.
10. Dispose live Browser state on session archive/delete and global shutdown; preserve profile, storage-state, download, annotation, and restored page-ID ownership.
11. Keep Browser implementations out of the Agent worker runner's static dependency graph. Only serializable Browser tool definitions cross into the worker; callbacks, canonical sessions, Playwright/Chromium state, host signaling, native views, and WebRTC state remain Control Plane/tool-runtime owned.
12. Attribute resource state by owner and page backend without exposing owner IDs. Retire the remote Host only after the broker reports no active canonical page; Performance aggregation must never close a page or stop the Host.
13. Keep Browser viewer Origin authorization on explicit server CORS origins. Do not promote auto-detected LAN CORS origins or reverse-proxy forwarding headers into the viewer trust boundary. Origin checks supplement one-shot owner/page/role-bound tickets and never replace them.

## Verify

1. Add a failing test for the public invariant before implementation. Cover page creation, owner isolation, control/event separation, host transitions, policy, persistence, or cleanup at the owning layer.
2. Run the focused Browser route/runtime/tool tests, Desktop Browser/view tests, and Web store/component tests affected by the change.
3. Typecheck `packages/synergy`, `packages/desktop`, and `packages/app`; regenerate the SDK only for OpenAPI-visible changes.
4. Exercise both relevant presentations in an isolated runtime. A native-only check does not prove WebRTC behavior, and a remote check does not prove Desktop bounds/lifecycle.
5. Finish with `bun run quality:quick` and update the architecture/product contract when ownership, lifecycle, policy, transport, or presentation changes.
6. When screenshot delivery changes, verify all three delivery paths: image-capable models receive provider-file image context; text-only models with an image-capable `vision_model` receive a real readable asset path and `look_at` guidance; text-only models without an image-capable `vision_model` receive only a local path with no tool guidance.
7. For native lifecycle changes, test both page timing orders: open workspace → first navigation and active page → open workspace. Verify a non-zero initial checkpoint, live surface attachment, close, and same-owner recreation.
8. For native recovery changes, force renderer exit, unexpected destruction, transient and sustained unresponsive states, CDP timeout, generation replacement while attached, recovery-budget exhaustion, explicit Retry, and a main-document timeout. Verify the healthy-path unresponsive reload is bounded by the shared recovery budget, and that mid-navigation loading events (redirects) never reset the navigation retry counter. Assert that managed-local Desktop never requests a viewer ticket or mounts WebRTC during any failure.
9. For Browser action changes, verify failure atomicity and agent-facing guidance. `select` must distinguish value from label, targeted scroll must finish on a real scroll container, and `includeSnapshot` must make the next DOM state available without a second tool call.
10. Run `packages/synergy/test/session/agent-worker-runtime-boundary.test.ts` when a shared Browser schema or utility can become reachable from Agent inference.
11. For resource-lifecycle changes, prove that an active page cancels idle Host retirement and report headless process coverage as partial when the driver cannot expose RSS.
12. When Playwright imports or standalone packaging change, build the compiled runtime, copy the whole packaged runtime to a different directory, and run the packaged Playwright loader check there. Verify release validation, the curl installer, and Desktop packaging all retain the filesystem-backed Playwright Core sidecar.
13. When Linux Browser installation changes, exercise dependency installation in each supported distribution family affected by the change. At minimum, test the oldest supported target image and confirm `browser doctor` names the independent repair command.
14. When Browser viewer Origin policy changes, cover same-origin, loopback peers, explicitly configured CORS origins, forged forwarding headers, automatic LAN-origin exclusion, Host local-file semantics, and process-global test cleanup.
15. When Browser Host packaging changes, keep Electron Builder executable names and manifest executable paths on one platform contract, then open each ZIP and prove the declared executable exists before hashing or signing.
16. For the recovery contract, verify `browser_navigation` with action `resume` on healthy, restarting, and failed native pages. Assert healthy resume does not replace the generation, concurrent resume calls share one recovery flight, failed recovery resets only the transient budget, safe observations remain available, side effects fail fast, and the owner/page identity is unchanged.
17. For settle and evidence changes, verify agent navigation `load`/15-second defaults, action `networkquiet`/10-second defaults, the 30-second hard cap, 500ms quiet window, timeout page state and best-effort snapshot, `browser_navigation current` without page creation, unknown-outcome no-replay guidance, and redacted bounded ambiguity candidates with usable refs.
18. For Browser observability changes, verify canonical event/metric/span and SQLite-store paths, correlation and trace propagation, bounded labels and redaction, broker disconnect status/error emission, and that performance reads do not own Browser lifecycle or claim unverified SLO coverage.

## Handoff

Report owner/page effects, command and event changes, persistence and cleanup, navigation/enforcement behavior, native and remote presentation coverage, generated contracts, tests, and manual runtime evidence.
