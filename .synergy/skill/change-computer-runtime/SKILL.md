---
name: change-computer-runtime
description: Change native Computer Use observation, targeting, action admission, image delivery, quality UI, or Cua packaging. Use for computer_apps, computer_observe and computer_action; Browser presentation belongs to change-browser-runtime.
---

# Change Native Computer Use

Read [Native Computer Use](../../../docs/architecture/computer-use.md), the nearest package rules, and `develop-synergy` for isolation. Trace the protocol, Desktop worker, broker/tool adapter, Harness image receipts and shared UI before changing a cross-cutting behavior.

## Implement and verify

1. Write a failing behavioral test at the owning boundary. Keep AX and image availability independent; assert that invalid or unverified images never become ordinary attachments. Exercise the actual route selected inside the native mutation lease, including semantic clicks that fall back to pixels. Trace upstream background routes for hidden activation, focus restoration and hardware-pointer use; a `background` argument alone does not prove non-interference.
2. Keep model-facing tools concise: target, returned evidence, allowed action and a useful recovery step. Translate native errors into the public tool vocabulary. Do not import upstream agent prompts, raw native JSON or internal repair procedures into model instructions.
3. Preserve exact image bytes and coordinate dimensions from capture through attachment and final provider transformation. Test the installed SDK's file/base64 and tool-result image representations as well as actual request bytes. Point admission reads the originating call's submitted receipt; capabilities, saved files and prior calls are insufficient.
4. Upgrade the official SDK and immutable worker source together. Keep local native adaptations under `apps/desktop/native/cua`, preserve MIT notices and implementation provenance, build with `desktop:prepare-computer`, and inspect its receipt. Both arm64 and x86_64 slices must compile; compilation alone is not execution evidence. Run native experiments in a separate source copy; never accept a build from a modified recipe cache. Regenerate the cached source from the pinned archive and owned patch before final acceptance.
5. Run focused Desktop Computer, Computer Runtime, Harness receipt and UI tests. Then run `desktop:test`, affected type checks and root `quality:quick`. Update generated contracts when public schemas change.

## Real acceptance

Use a logged-in macOS session and an isolated Home with separate ports and Electron userData. `bun dev desktop --server-port 5147 --app-port 3147` starts the matching server and native host; `--attach` alone does not register a Computer host. Never borrow the live runtime or silently copy credentials. Existing user authorization to copy a specific provider is sufficient; copy only that provider's configuration and credential into the test Home.

Run the fixtures serially; they share the physical desktop even across isolated Homes:

```bash
bun run test:computer-native
SYNERGY_HOME=/absolute/isolated-home SYNERGY_COMPUTER_SERVER_URL=http://127.0.0.1:5147 bun run test:computer-acceptance
```

The first command checks the patched native worker with disposable same-app windows and independent counters. Fixture setup places windows behind the user's app without activating them. Both scripts record application-activation and Space-change events throughout execution; matching foreground PIDs before and after is insufficient. Do not activate a fixture merely to make capture pass. With Stage Manager enabled, verify that a transformed representation is withheld while independent AX actions remain available, and distinguish it from a legitimate narrow window. The second command invokes the real Synergy model/tool pipeline, reads a canvas-only random code, performs one point action, verifies the independent app counter and checks durable submitted image hashes. Provider/model default to `deepseek/deepseek-flash`; override with `SYNERGY_COMPUTER_PROVIDER` and `SYNERGY_COMPUTER_MODEL`. `SYNERGY_COMPUTER_REPORT_DIR` selects the artifact directory. Exit codes are 0 pass, 1 fail, 2 blocked. Missing GUI, TCC or credentials must not be reported as success; never pass the private oracle or nonce through model context.

Include worker startup in the focus timeline. Preserve user focus changes instead of restoring an old foreground app. Keep raw-canvas hit counters as a real gate: adding first-mouse acceptance to the fixture or substituting an AX button changes the scenario. Record other desktop automation and user Space changes as interference; do not silently lower the acceptance assertion.

Read each fixture window's `onActiveSpace` oracle when diagnosing missing AX identity. A visible window can belong to another Space, where macOS may omit it from the app's AX window list. Preserve that failed or blocked case separately from current-Space results; do not switch Spaces or activate the target to make the same run pass.

Inspect reports and personally open the resulting session. Verify CN/EN quality labels, collapsed details with keyboard operation, missing-image behavior and a narrow viewport. Report native observations separately from saved attachments and submitted model input.

Before accepting a distribution change, build the full Desktop candidate, copy its `.app` outside the checkout, launch with explicit isolated `SYNERGY_HOME` and `SYNERGY_DESKTOP_USER_DATA_DIR`, and repeat model acceptance through its managed server. Verify the active worker and SDK paths belong to that bundle. Rust cannot load libraries from ASAR virtual paths; the complete Cua/UniFFI packages and the imported SDK entry must resolve physically under `app.asar.unpacked`. An unsigned local `--dir` candidate may need ad-hoc signing before launch; this is not distribution signing or notarization. Source-host permissions do not prove installed-app grants. Also record Stage Manager, window transitions and mixed-DPI evidence; a fixture or schema test cannot substitute for a missing physical environment. Keep these gates blocked until exercised, without changing the user's desktop preferences implicitly.

Update the canonical architecture, implemented decision and this workflow in the same task when a durable rule changes. Keep verification artifacts private and ignored; never commit Home paths, credentials or personal window contents.
