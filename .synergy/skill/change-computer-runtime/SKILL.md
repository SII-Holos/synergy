---
name: change-computer-runtime
description: Change native Computer Use observation, targeting, action admission, image delivery, quality UI, or Cua packaging. Use for computer_apps, computer_observe and computer_action; Browser presentation belongs to change-browser-runtime.
---

# Change Native Computer Use

Read [Native Computer Use](../../../docs/architecture/computer-use.md), the nearest package rules, and `develop-synergy` for isolation. Trace the protocol, Desktop worker, broker/tool adapter, Harness image receipts and shared UI before changing a cross-cutting behavior.

## Implement and verify

1. Write a failing behavioral test at the owning boundary. Keep AX and image availability independent; an observation with both channels unavailable must still preserve capture diagnostics and a recovery path. Assert that invalid or unverified images never become ordinary attachments. Exercise the actual route selected inside the native mutation lease, including semantic clicks that fall back to pixels. Trace upstream background routes for hidden activation, focus restoration and hardware-pointer use; a `background` argument alone does not prove non-interference.
2. Keep model-facing tools concise: target, returned evidence, allowed action and a useful recovery step. Translate native errors into the public tool vocabulary. Distinguish a missing OS capture grant from a window capture failure: foreground observation cannot repair missing permission. Do not import upstream agent prompts, raw native JSON or internal repair procedures into model instructions.
3. Preserve exact image bytes and coordinate dimensions from capture through attachment and final provider transformation. Test the installed SDK's file/base64 and tool-result image representations as well as actual request bytes. All model-supplied coordinates share admission from the originating call's submitted image receipt; capabilities, saved files and prior calls are insufficient.
4. Upgrade the official SDK and immutable worker source together. Keep local native adaptations under `apps/desktop/native/cua`, preserve MIT notices and implementation provenance, build with `desktop:prepare-computer`, and inspect its receipt. Both arm64 and x86_64 slices must compile; compilation alone is not execution evidence. Run native experiments in a separate source copy; never accept a build from a modified recipe cache. Regenerate the cached source from the pinned archive and owned patch before final acceptance.
5. Run focused Desktop Computer, Computer Runtime, Harness receipt and UI tests. Then run `desktop:test`, affected type checks and root `quality:quick`. Update generated contracts when public schemas change.

For changes limited to driver-build feedback, run the build-progress, packaging and development-entrypoint tests, then exercise cold and verified-cache builds with `bun dev build desktop` in the task worktree. Check immediate phase output, five-second pending updates, known and unknown download sizes, failure propagation and timer cleanup. Use temporary archives and a local HTTP server for automated download cases; keep the pinned source and patch unchanged for native builds. Build status follows [the development reference](../../../docs/reference/development.md#requirements-and-preparation). Progress-reporting tests and a successful build do not replace native or model acceptance when execution behavior changes.

## Real acceptance

Use a logged-in macOS session and an isolated Home with separate ports and Electron userData. `bun dev desktop --server-port 5147 --app-port 3147` starts the matching server and native host; `--attach` alone does not register a Computer host. Never borrow the live runtime or silently copy credentials. Existing user authorization to copy a specific provider is sufficient; copy only that provider's configuration and credential into the test Home.

Run the fixtures serially, separately from headed Electron/browser tests; they share the physical desktop even across isolated Homes and worktrees. Preserve interference failures and never stop another task's runtime to make a test pass:

```bash
bun run test:computer-native
SYNERGY_HOME=/absolute/isolated-home SYNERGY_COMPUTER_SERVER_URL=http://127.0.0.1:5147 bun run test:computer-acceptance
```

The native script uses two disposable AppKit windows with independent counters for clicks, directed text, values, scrolling, double/right clicks, keys, shortcuts and drag. Background text uses a standard editable `NSTextView` to exercise Cua's exact AX insertion. A control that rejects AX insertion can require foreground delivery when process-wide keys might reach a sibling window; preserve Cua's refusal and never weaken sibling-window checks. It checks background observation, explicit foreground recovery, AX-independent capture, occlusion, narrow windows and stale targets. Only read-only observation may repeat while a transition settles; never replay a mutation to make a counter pass.

Keep default-background cases and explicit-foreground cases separate. Fixtures initially open behind the user. Foreground setup and actions must go through the public `foreground:true` path and be recorded as such; they are allowed. Check focus events over the background interval, not over a run that deliberately includes foreground operations. Preserve Cua's activation and restoration policies rather than adding a parallel focus manager. Foreground input excludes other input only while in flight.

With Stage Manager enabled, ensure thumbnails are withheld even when AX content is unavailable, then recover through a fresh foreground observation. Also check a genuinely narrow window so geometry checks cannot become a size heuristic. Record off-Space evidence separately; foreground recovery can move the target's Space and must not be reported as a background pass.

The first foreground-click check requires an initial background image on the active Space. Record an off-Space fixture as blocked before dispatch; never infer a failed click from a capture prerequisite or bring it forward first to manufacture that evidence.

The model script reads a canvas-only random code, makes one explicit foreground coordinate click, verifies the independent counter and checks exact submitted image hashes. The canvas exposes a visible Hits count so the agent can confirm the effect from its next image. Never place the private oracle or nonce in model context, add first-mouse acceptance to make a canvas pass, or substitute an AX button for its visual target. Also test the first foreground click directly from a background observation: a foreground observation beforehand can hide activation defects. Require a single hit and Cua's restoration of the previous application; reuse its exact-window foreground proof rather than adding a separate focus manager. Provider/model default to `deepseek/deepseek-flash`; environment overrides remain `SYNERGY_COMPUTER_PROVIDER`, `SYNERGY_COMPUTER_MODEL`, and `SYNERGY_COMPUTER_REPORT_DIR`. Exit codes are 0 pass, 1 fail, 2 blocked. Missing GUI, TCC or credentials are blocked, never passed.

Inspect reports and personally open the resulting session. Verify CN/EN quality labels, collapsed details with keyboard operation, missing-image behavior and a narrow viewport. Execution mode must remain visible in the result body because the activity trace can own and replace a tool's header. At phone width, mode and delivery status must wrap rather than disappear behind truncated labels or values. Report native observations separately from saved attachments and submitted model input.

Before accepting a distribution change, build the full Desktop candidate, copy its `.app` outside the checkout, launch with explicit isolated `SYNERGY_HOME` and `SYNERGY_DESKTOP_USER_DATA_DIR`, and repeat model acceptance through its managed server. Verify the active worker and SDK paths belong to that bundle. Rust cannot load libraries from ASAR virtual paths; the complete Cua/UniFFI packages and the imported SDK entry must resolve physically under `app.asar.unpacked`. An unsigned local `--dir` candidate may need ad-hoc signing before launch; this is not distribution signing or notarization. Source-host permissions do not prove installed-app grants. Also record Stage Manager, window transitions and mixed-DPI evidence; a fixture or schema test cannot substitute for a missing physical environment. Keep these gates blocked until exercised, without changing the user's desktop preferences implicitly.

Update the canonical architecture, implemented decision and this workflow in the same task when a durable rule changes. Keep verification artifacts private and ignored; never commit Home paths, credentials or personal window contents.
