# Decision Record: Bind native notification streams to their document

Status: implemented

## Problem

An organization notification response is an unbounded-lived authenticated stream rather than a JSON request. Giving the renderer a bearer or arbitrary streaming URL would bypass Main's connection owner. Forwarding frames without renderer acknowledgement could accumulate IPC messages after navigation or during a slow renderer.

## Decision

Desktop bridge version two advertises a separate optional notification version one. Its typed start selects an existing connection ID and exact opaque revision with a fresh request nonce. Stop and internal acknowledgement select that same subscription; acknowledgements also bind stream ID and sequence. The API accepts no URL, path, cookie or credential. Old bridges advertise no notification feature.

Main captures the trusted document generation, connection descriptor, account, deployment and revision before opening the fixed generated `orgNotifications.stream` operation. It rechecks document and current account metadata before forwarding each frame. Sign-out and document invalidation reuse the existing request lease cancellation. A stream has an idle deadline but no total lifetime deadline while valid heartbeats continue. Closing or replacing its account retires the captured request rather than adopting new credentials.

The protocol decoder validates the raw response before the generated SDK's SSE parser consumes it. This keeps frame size, UTF-8, audience and sequence checks at the byte boundary; the generated helper cannot buffer an oversized unvalidated event or retry an old stream implicitly. The wrapper has no prefetch queue. Main permits one unacknowledged frame, and preload acknowledges only after its registered listeners finish. Missing acknowledgement closes the individual stream within a finite deadline. Only the original trusted frame receives events; closure contains a fixed error code rather than remote text.

## Alternatives considered

**Reuse the generic JSON bridge.** Its response byte and deadline rules are incompatible with a live stream. The notification route stays outside that allowlist.

**Expose a general native EventSource or bearer token.** Those APIs permit caller-selected destinations or move credentials into the renderer. This action selects one fixed service operation under Main's existing account owner.

**Forward every event to Electron immediately.** Network backpressure does not bound a renderer's IPC queue. Per-frame acknowledgement preserves a bounded native-to-renderer lifetime.

## Consequences

Focused tests cover one-frame acknowledgement, a held next frame across account revision replacement, document disposal, slow consumers and secret exclusion. A real temporary service and native encrypted account fixture exercise the generated stream through Main IPC, reject generic JSON access, bind the ready audience, reject changed acknowledgements and invalidate the original document. Protocol tests reject caller-selected paths, missing revisions and ambiguous acknowledgements. These tests do not claim production Electron preload or cross-space Web presentation acceptance; those remain required integration work.
