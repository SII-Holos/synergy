# Decision Record: Native application Computer Use

Status: implemented

## Problem

Synergy can operate its session-owned Browser, but tasks involving existing native applications need application-window observation and input. Exposing an unrestricted external automation server would leave task identity, permissions, cancellation, screenshots, and distribution outside Synergy's product lifecycle.

## Decision

Native Computer Use is implemented through first-party tools and a local Desktop host. The core runtime owns task identity, Full Access eligibility, persisted tool output, and image delivery. The private `packages/computer` package defines bounded commands and host messages. Desktop owns a private Cua Driver worker, launched lazily through its official TypeScript SDK. This is not a user-configured MCP server or plugin.

Use Cua Driver 0.23.2's exact-window background operations. A task observes an explicit process/window pair and receives a short-lived, single-action observation reference. Desktop injects the driver session and snapshot identity; model input cannot choose either. Observation references are invalidated after an action, a replacement observation, or a host reconnect. Actions never retry automatically and never fall back to foreground delivery.

Do not hold a desktop-wide lease for the duration of a task. Different applications may execute concurrently. Each application has at most one Synergy operation in flight, complementing Cua's short per-process native mutation serialization. This prevents overlapping focus/snapshot operations without preventing another task from working in a different app. Same-application tasks do not get independent application state.

Require `full_access` for observation as well as interaction. Ordinary permission approvals cannot enable Computer Use under `guarded` or `autonomous`. Desktop OS permissions remain independently required. Ordinary task cancellation and bounded calls remain available; no separate emergency-stop, takeover, or desktop-control panel is introduced.

Ship the verified macOS universal driver inside Desktop resources with its MIT notice. Keep the driver version and archive/executable digests in the build manifest. Other platforms and remote Desktop hosts return an explicit unsupported/unavailable result. The first version covers finding windows, observation, element/pixel clicks, text, individual navigation keys, and scrolling; no arbitrary scripts, app launching, clipboard service, or desktop-wide input is exposed.

## Alternatives considered

**Public Cua plugin.** A plugin would be easy to configure but would duplicate session binding and leave native driver packaging and macOS permission attribution outside the Desktop lifecycle. It is not the selected distribution model.

**Codex implementation reuse.** Copying Codex's packaged implementation would depend on private application APIs and licensing assumptions. Cua provides a published MIT implementation and supported embedding interface instead.

**Task-long desktop lock.** A desktop lock would unnecessarily prevent background work in independent applications. Cua's [per-PID mutation implementation](https://github.com/trycua/cua/blob/cua-driver-rs-v0.23.2/libs/cua-driver/rust/crates/platform-macos/src/background_mutation.rs) serializes the affected process only. Its [embedding documentation](https://github.com/trycua/cua/blob/cua-driver-rs-v0.23.2/libs/cua-driver/rust/Skills/cua-driver/EMBEDDING.md) supports host-owned runtimes and host-attributed OS permissions.

**Daemon or same-process embedding.** The standalone-compatible daemon writes a global PID file even with a private socket in Cua 0.23.2. The official SDK private worker avoids that shared state and owns its inherited pipe lifecycle. Its native Node module and dynamic library are kept outside ASAR. Same-process integration would put native automation failures inside Electron; the worker keeps execution in a child process.

## Consequences

Automated checks cover the protocol, Full Access eligibility and profile downgrade, observation ownership, per-application admission, cancellation, host reconnection, tool presentation, and packaging inputs. Standalone macOS end-to-end validation remains incomplete: the isolated application has not received its own Accessibility and Screen Recording grants. Earlier terminal-launched probes do not establish standalone permission attribution or complete end-to-end success.

Background operation support varies across apps and actions. Driver delivery is not proof of a business outcome; the agent must observe again. Unsupported actions and unverifiable effects remain visible. A cancellation, timeout, or disconnection can occur after an input event was delivered, so retry requires a fresh observation.

Computer Use does not inherit Browser page ownership or its presentation model. Existing native windows remain user-owned and can change independently. The initial implementation does not promise isolation between tasks operating the same application's state, across multiple Desktop processes, or against concurrent human edits.
