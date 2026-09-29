# Native Computer Use

## Ownership

Computer Use operates existing macOS application windows through local Synergy Desktop. The core `computer` domain registers the first-party tools, checks the current effective control profile, derives ownership from the canonical session/root message, and persists tool output and screenshot attachments. The private `packages/computer-protocol` package owns the bounded protocol. Desktop translates commands into Cua Driver operations in a lazily started private worker through the official TypeScript SDK.

`computer_apps` lists enumerable windows, including off-screen windows. `computer_observe` binds an exact process/window pair and returns its accessibility tree, available screenshot, and an observation reference. `computer_action` accepts one action against that reference. The generated [tool catalog](../reference/tools.md) defines the public parameters.

## Authorization and targeting

Both Computer capabilities require Full Access. The central enforcement gate denies other profiles even if a permission rule would allow the capability. The command service resolves the effective profile again before native dispatch. macOS Accessibility and Screen Recording grants are observed independently. A missing Screen Recording grant disables capture while preserving available AX results and semantic actions. Missing grants are ordinary runtime failures; Full Access does not supply an OS grant.

The core connects to exactly one authenticated local Desktop host through `/computer/host/broker`. A random registration secret is passed out of band by the managed Desktop or development orchestrator. Browser-origin WebSocket clients cannot register. Desktop only connects its Computer host to loopback servers.

A model cannot select the driver session, change delivery mode, execute scripts, launch an application, or target the whole desktop. Desktop injects a random driver session per task and the process/window/snapshot from its own observation record. References expire after one minute, permit one action, and are discarded on replacement or host reconnect.

Observation and action use background window routes. Guarded pixel clicks suppress target activation and cannot select Cua's activation-without-raise prologue or foreground assistance. Missing background support does not authorize switching apps, raising a window, switching Spaces, moving the hardware pointer, or briefly taking focus and restoring it. Application effects still require a fresh observation. The [background focus decision](../decisions/implemented/bug-fix/2026-09-29-computer-background-focus.md) records this restriction.

Guarded actions do not restore a previously active application when the user changes focus. The private worker runs AppKit without activation or its own overlay windows; Desktop owns permission and progress presentation. An unsupported background route returns a concise limitation without recommending foreground escalation.

## Concurrency and lifecycle

Independent applications may run concurrently. An in-flight operation excludes another operation targeting the same process; it does not reserve the desktop or app for an entire task. Cua additionally serializes native background mutations per process. New observations invalidate older references for the same window across tasks. Shared application state remains shared with the user and other tasks.

Requests are bounded and cancellable. Disconnection rejects pending operations and does not replay them. A restarted driver loses observation records. A runtime generation check rejects late results from operations that crossed a reset, including observations from independent applications. Native success, including an `unverifiable` effect, does not establish completion of the user's task. A fresh observation is required to verify results and before considering a retry after an uncertain outcome.

The host process belongs to Desktop and is closed with its broker connection. The driver does not register a separate daemon or global MCP configuration. Cua telemetry is disabled in the child environment. Driver sessions expire upstream when idle; Desktop bounds its retained task records separately.

## Distribution

Desktop builds Cua 0.30.4 from a checksum-verified immutable source archive with the owned observation patch and pinned Rust toolchain. The build receipt binds source, patch, architecture and executable digest. The executable and MIT notice are copied into `Resources/computer`; the macOS signing configuration includes the nested executable. The matching pinned TypeScript SDK stays external to the JavaScript bundle; its complete Cua and UniFFI packages are unpacked from ASAR. Desktop imports the SDK from the physical unpacked entry so Rust resolves sibling dynamic libraries outside the virtual archive. Development can supply `SYNERGY_COMPUTER_DRIVER_PATH` explicitly. Other platforms and remote server connections do not provide native Computer Use.

The [decision record](../decisions/implemented/feature/2026-09-07-first-party-computer-use.md) records the concurrency and embedding tradeoffs. [Desktop release](../operations/desktop-release.md) owns packaging procedures.

Native Computer tools require a Session selecting the native Environment as well as Full Access. They hold the Session binding through dispatch and reject absent or remote execution selections before contacting Desktop. This component does not advertise Computer execution inside Docker.

## Observation quality

Protocol version 2 carries separate AX, image and per-action availability. Desktop returns one AX rendering bounded to 32 KiB of UTF-8; `query` narrows the returned accessibility projection without renumbering elements. Missing or partial AX content does not establish absence. Native captures are capped at a 2048-pixel long edge and bind the exact delivered bytes to an immutable Cua capture. A screenshot is usable only when native decoding, logical window geometry, content-plane geometry and byte digest agree. Invalid or unverified captures do not become normal model attachments.

An unavailable capture suggests one fresh observation after the window settles, then an available AX action or an explicit limitation. This recovery reads a new observation; it never retries a mutation or weakens image validation.

The native patch compares process start time, retained AX window identity and logical geometry again inside Cua's per-process mutation lease. Pixel routes additionally verify WindowServer geometry and the captured content plane, even when selected internally by a semantic click. Display transforms may invalidate pixels while preserving independent AX actions. Desktop references use monotonic expiry, are consumed before action validation, and cannot survive native resets or replacement observations. The [observation admission decision](../decisions/implemented/bug-fix/2026-09-29-computer-observation-admission.md) records the tradeoffs.

`SYNERGY_DESKTOP_USER_DATA_DIR` selects an absolute Electron user directory before single-instance locking. Source development derives this directory under an explicitly selected Home, isolating cookies and browser profiles as well as runtime state. It does not isolate the physical macOS desktop.

## Model delivery and presentation

Harness records image hashes at the final provider transform and at the existing request transport. The tool executor reads the receipt for the model call that emitted that tool call; it never borrows a previous call’s image evidence. Coordinate clicks require the observed image hash among that request’s submitted images. A saved attachment or a model capability flag alone is not submission evidence. Unknown wire formats and streaming request bodies without a byte receipt remain unverified. Receipt fields are optional for historical rollout attempts.

Computer attachments retain their original image dimensions and digest. Text-only models receive a concise attachment summary and cannot supply point admission. The shared tool card presents the target, AX quality, image validation, delivery stage and observed action support separately. Historical observations show unknown quality; missing attachments never imply model delivery. Raw observation text stays in the expandable details.

## Verification

The [Computer development workflow](../../.synergy/skill/change-computer-runtime/SKILL.md) owns repeatable native, real-model and packaged-app acceptance. Native fixtures use two windows in one disposable AppKit process, random AX text, a canvas-only code and independent action counters. Fixture state is private to the evaluator. Reports distinguish pass, fail and blocked; source-host success does not establish installed-app TCC, Stage Manager or mixed-DPI behavior. Build receipts carry a universal macOS worker; x86_64 cross-compilation does not establish execution on Intel hardware.
