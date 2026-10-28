# Decision Record: Explicit software rendering for Linux native Browser smoke tests

Status: implemented

## Problem

The native Browser smoke fixture can stall in screenshot capture under Linux/Xvfb even though its WebContents accepts viewport changes. Repeated CI attempts timed out in the same fixture while its ordinary unit tests passed. A controlled Linux experiment with the pinned Electron version also observed `Page.captureScreenshot` remaining pending until the fixture deadline; another unchanged run succeeded. Running the same native fixture with `--disable-gpu` completed its geometry, screenshot and recovery assertions.

## Decision

The [native Browser smoke runner](../../../../apps/desktop/test/browser-runtime-smoke.test.ts) passes `--disable-gpu` to its Linux Electron children. The fixture keeps real BrowserWindow and WebContentsView instances, CDP screenshots, renderer recovery, visibility and geometry assertions, and the same deadlines. The setting is confined to tests. Production Desktop launch arguments and other platforms are unchanged.

The [Browser verification Skill](../../../../.synergy/skill/change-browser-runtime/SKILL.md) identifies Linux/Xvfb evidence as software-rendered native acceptance. This is an environment choice supported by the controlled experiment, not a conclusion that every screenshot stall has the same cause.

The geometry fixture reports static stage labels and elapsed time around viewport waits, metrics commands and capture. An attached bounds/viewport observation alone does not identify the command pending at a later timeout. These markers add no native reads or commands, retain every original assertion and deadline, and contain no page, owner, path or content data. They diagnose command completion; adding observation is not a repair for a stalled command.

## Alternatives considered

**Retry the unchanged job.** The failure recurred in CI and the unchanged local fixture both failed and passed. Retries do not make the graphics backend deterministic.

**Increase the fixture deadline or remove screenshot assertions.** A pending capture is not evidence of slow but healthy progress. Both choices weaken the fixture without addressing its rendering environment.

**Change production capture or rendering.** The observed failure is in the virtual-display test environment. This evidence does not justify changing user-facing rendering behavior.

## Consequences

Linux CI retains native page and compositor behavior without relying on automatic hardware-backend selection under Xvfb. It does not establish physical Linux GPU compatibility. Real-display acceptance remains necessary for hardware-specific rendering changes; the test suite's existing macOS and Windows launch behavior remains available for their native environments.
