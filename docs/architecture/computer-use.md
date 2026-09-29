# Native Computer Use

## Ownership

Computer Use operates existing macOS application windows through local Synergy Desktop. The core `computer` domain registers the first-party tools, checks the current effective control profile, derives ownership from the canonical session/root message, and persists tool output and screenshot attachments. The private `packages/computer-protocol` package owns the bounded protocol. Desktop translates commands into Cua Driver operations in a lazily started private worker through the official TypeScript SDK.

`computer_apps` lists enumerable windows, including off-screen windows. `computer_observe` binds an exact process/window pair and returns its accessibility tree, available screenshot, and an observation reference. `computer_action` accepts one action against that reference. The generated [tool catalog](../reference/tools.md) defines the public parameters.

## Authorization and targeting

Both Computer capabilities require Full Access. The central enforcement gate denies other profiles even if a permission rule would allow the capability. The command service resolves the effective profile again before native dispatch. macOS Accessibility and Screen Recording grants are observed independently. A missing Screen Recording grant disables capture while preserving available AX results and semantic actions. The observation identifies the missing grant and requests permission followed by an app restart; foreground capture cannot repair an absent OS grant. Missing grants are ordinary runtime failures; Full Access does not supply an OS grant.

The core connects to exactly one authenticated local Desktop host through `/computer/host/broker`. A random registration secret is passed out of band by the managed Desktop or development orchestrator. Browser-origin WebSocket clients cannot register. Desktop only connects its Computer host to loopback servers.

A model can explicitly select `foreground:true` for observation or input; background is the default. It cannot select the driver session, execute scripts, launch an application, or target the whole desktop. Desktop injects a random driver session per task and the process/window/snapshot from its own observation record. References expire after one minute, permit one action, and are discarded on replacement or host reconnect.

Observation reads an exact window without activating it by default. `computer_observe.foreground:true` calls Cua's exact-window `bring_to_front`, verifies activation, then observes again; the window remains in front. Actions pass the agent's explicit foreground choice to Cua. Cua owns background delivery, temporary activation and focus restoration; background is a best-effort preference, not a promise of zero focus changes. Unsupported background input suggests observing again before explicitly choosing foreground. Synergy never escalates or replays a mutation automatically.

`computer_action` has six operations: `click`, `type`, `key`, `scroll`, `drag`, and `set_value`. A target is either a returned `{elementIndex}` or an image `{x,y}` point. Click supports button and count; text requires a target; keys accept modifiers and an optional target; scrolling accepts an optional target; dragging accepts two image points. `set_value` requires an element and stays semantic. Element requests carry the exact snapshot to Cua. There is no separate point command or legacy execution alias. The [current delivery decision](../decisions/implemented/feature/2026-09-29-computer-background-preferred.md) records the scope and tradeoffs.

Exact-element text uses Cua's AX insertion when the control supports it. If AX insertion is unavailable and process keyboard events could reach a sibling window, the host reports background unavailability; it does not bypass Cua's same-process ambiguity check. A fresh observation can precede an explicit foreground attempt.

The private worker runs Cua's AppKit loop without its cursor overlay. Desktop owns permission and progress presentation.

## Concurrency and lifecycle

Independent applications may run concurrently. An in-flight operation excludes another operation targeting the same process; it does not reserve the desktop or app for an entire task. An explicit foreground operation excludes other input for its duration because physical input and focus are desktop-wide; background input can run concurrently in different applications. Cua additionally serializes native background mutations per process. New observations invalidate older references for the same window across tasks. Shared application state remains shared with the user and other tasks.

Requests are bounded and cancellable. Disconnection rejects pending operations and does not replay them. A restarted driver loses observation records. A runtime generation check rejects late results from operations that crossed a reset, including observations from independent applications. Native success, including an `unverifiable` effect, does not establish completion of the user's task. A fresh observation is required to verify results and before considering a retry after an uncertain outcome.

The host process belongs to Desktop and is closed with its broker connection. The driver does not register a separate daemon or global MCP configuration. Cua telemetry is disabled in the child environment. Driver sessions expire upstream when idle; Desktop bounds its retained task records separately.

## Distribution

Desktop builds Cua 0.30.4 from a checksum-verified immutable source archive with the owned observation patch and pinned Rust toolchain. The build receipt binds source, patch, architecture and executable digest. The executable and MIT notice are copied into `Resources/computer`; the macOS signing configuration includes the nested executable. The matching pinned TypeScript SDK stays external to the JavaScript bundle; its complete Cua and UniFFI packages are unpacked from ASAR. Desktop imports the SDK from the physical unpacked entry so Rust resolves sibling dynamic libraries outside the virtual archive. Development can supply `SYNERGY_COMPUTER_DRIVER_PATH` explicitly. Other platforms and remote server connections do not provide native Computer Use.

The [decision record](../decisions/implemented/feature/2026-09-07-first-party-computer-use.md) records the concurrency and embedding tradeoffs. [Desktop release](../operations/desktop-release.md) owns packaging procedures.

Native Computer tools require a Session selecting the native Environment as well as Full Access. They hold the Session binding through dispatch and reject absent or remote execution selections before contacting Desktop. This component does not advertise Computer execution inside Docker.

## Observation quality

Protocol version 3 rejects older hosts and carries observation schema version 2 with separate AX, image and per-action availability. Desktop returns one AX rendering bounded to 32 KiB of UTF-8; `query` narrows the returned accessibility projection without renumbering elements. Missing or partial AX content does not establish absence. Native captures are capped at a 2048-pixel long edge and bind the exact delivered bytes to an immutable Cua capture. A screenshot is usable only when native decoding, WindowServer/SCK process and window identity, capture geometry and byte digest agree. Invalid or unverified captures do not become normal model attachments.

Process start time and WindowServer identity do not depend on AX availability. When an AX window is available, its retained identity and logical frame provide an additional proof. AX failure does not discard a valid SCK image. The capture rejects a window paired geometrically with a WindowManager container (Stage Manager), AX/WindowServer mismatches, and content-plane mismatches. It does not use a minimum width or screenshot aspect-ratio heuristic. An unavailable image suggests a fresh foreground observation when pixels are needed. When neither channel produces content, the observation still preserves channel status and capture diagnostics instead of becoming an opaque native error. Foreground observation can repeat capture during a brief geometry transition; it never repeats input.

The owned native patch preserves exact-window AX projection, image validation and one-use action admission. It revalidates the target before dispatch and under Cua's background mutation lease; pixel routes additionally recheck capture geometry. Foreground HID activation reuses Cua's exact-window raise and stable foreground proof before posting input, then preserves Cua's focus restoration. AX focus alone does not prove that a covered window can receive a physical click. Foreground activation refuses input if it changes the geometry used to resolve coordinates. References expire monotonically and cannot survive replacement, cancellation/reset or reconnect. Native Cua remains the authority for whether a control supports the selected input route.

`SYNERGY_DESKTOP_USER_DATA_DIR` selects an absolute Electron user directory before single-instance locking. Source development derives this directory under an explicitly selected Home, isolating cookies and browser profiles as well as runtime state. It does not isolate the physical macOS desktop.

## Model delivery and presentation

Harness records image hashes at the final provider transform and at the existing request transport. The tool executor reads the receipt for the model call that emitted that tool call; it never borrows a previous call’s image evidence. Every model-supplied coordinate (click, type, key, scroll and both drag endpoints) requires the observed image hash among that request’s submitted images. A saved attachment or a model capability flag alone is not submission evidence. Unknown wire formats and streaming request bodies without a byte receipt remain unverified. Receipt fields are optional for historical rollout attempts.

Computer attachments retain their original image dimensions and digest. Text-only models receive a concise attachment summary and cannot supply coordinate admission. The shared tool card labels background preference or foreground operation, keeps target and image evidence visible, and labels successful dispatch as requiring observation to confirm. Detailed native diagnostics remain collapsed. Historical observations show unknown quality; missing attachments never imply model delivery. Raw observation text stays in the expandable details.

## Verification

The [Computer development workflow](../../.synergy/skill/change-computer-runtime/SKILL.md) owns repeatable native, real-model and packaged-app acceptance. Native fixtures use two windows in one disposable AppKit process, random AX text, a canvas-only code and independent action counters. Fixture state is private to the evaluator. Reports distinguish pass, fail and blocked; source-host success does not establish installed-app TCC, Stage Manager or mixed-DPI behavior. Build receipts carry a universal macOS worker; x86_64 cross-compilation does not establish execution on Intel hardware.
