# Native Computer Use

## Ownership

Computer Use operates existing macOS application windows through local Synergy Desktop. The core `computer` domain registers the first-party tools, checks the current effective control profile, derives ownership from the canonical session/root message, and persists tool output and screenshot attachments. The private `packages/computer` package owns the bounded protocol. Desktop translates commands into Cua Driver operations in a lazily started private worker through the official TypeScript SDK.

`computer_apps` lists on-screen windows. `computer_observe` binds an exact process/window pair and returns its accessibility tree, available screenshot, and an observation reference. `computer_action` accepts one action against that reference. The generated [tool catalog](../reference/tools.md) defines the public parameters.

## Authorization and targeting

Both Computer capabilities require Full Access. The central enforcement gate denies other profiles even if a permission rule would allow the capability. The command service resolves the effective profile again before native dispatch. macOS Accessibility and Screen Recording permissions are separate runtime prerequisites; Desktop requests Accessibility when a Computer operation first encounters a missing grant and reports missing Screen Recording explicitly.

The core connects to exactly one authenticated local Desktop host through `/computer/host/broker`. A random registration secret is passed out of band by the managed Desktop or development orchestrator. Browser-origin WebSocket clients cannot register. Desktop only connects its Computer host to loopback servers.

A model cannot select the driver session, change delivery mode, execute scripts, launch an application, or target the whole desktop. Desktop injects a random driver session per task and the process/window/snapshot from its own observation record. References expire after one minute, permit one action, and are discarded on replacement or host reconnect.

## Concurrency and lifecycle

Independent applications may run concurrently. An in-flight operation excludes another operation targeting the same process; it does not reserve the desktop or app for an entire task. Cua additionally serializes native background mutations per process. New observations invalidate older references for the same window across tasks. Shared application state remains shared with the user and other tasks.

Requests are bounded and cancellable. Disconnection rejects pending operations and does not replay them. A restarted driver loses observation records. Native success, including an `unverifiable` effect, does not establish completion of the user's task. A fresh observation is required to verify results and before considering a retry after an uncertain outcome.

The host process belongs to Desktop and is closed with its broker connection. The driver does not register a separate daemon or global MCP configuration. Cua telemetry is disabled in the child environment. Driver sessions expire upstream when idle; Desktop bounds its retained task records separately.

## Distribution

Desktop builds prepare a versioned macOS universal Cua executable from a pinned archive and verify both archive and executable digests. The executable and MIT notice are copied into `Resources/computer`; the macOS signing configuration includes the nested executable. The matching pinned TypeScript SDK stays external to the JavaScript bundle; its native module and dynamic library are unpacked from ASAR. Development can supply `SYNERGY_COMPUTER_DRIVER_PATH` explicitly. Other platforms and remote server connections do not provide native Computer Use.

The [decision record](../decisions/implemented/feature/2026-09-07-first-party-computer-use.md) records the concurrency and embedding tradeoffs. [Desktop release](../operations/desktop-release.md) owns packaging procedures.
