# Decision Record: Chunk organization command deliveries and wait for transport capacity

Status: implemented

## Problem

Organization command input was limited to a single small JSON frame, while the service and member bridge also rejected normal work as soon as their transient exchange windows or socket buffers were full. This made large but valid inline input fail at the transport boundary and turned temporary backpressure into an immediate product error. A command that had already placed part of its delivery on the socket could not safely be retried without preserving the existing unknown-outcome rules.

## Decision

The command protocol accepts text parts up to 1 MiB each, 128 parts, and a 4 MiB serialized input payload. The runtime server frame union has a strict `command-chunk` frame containing the connection epoch, exchange ID, contiguous index, total count and base64url data. A chunk carries at most 43 KiB of raw command JSON, which stays below the 60,000-character wire bound after encoding.

The organization service serializes each delivery once. Small deliveries remain ordinary `command` frames; larger deliveries are split into ordered chunks under one exchange ID. Before creating an exchange, the sender waits cancellably for the relevant 16-entry command or reconciliation window and for the socket's buffered amount to fall to 64 KiB or less. A send result of zero still means that the frame was dropped; an earlier enqueued chunk followed by a zero result leaves the exchange unknown, and no chunk is resent. Forwarder capacity waits use the request deadline and cancellation, and a request cancelled before reservation is definitely not dispatched.

The member runtime validates chunk epoch, exchange identity, total and contiguous index, canonical base64url and strict UTF-8 JSON. It bounds the aggregate in-progress chunk buffer at 64 MiB, clears it on connection stop, parses one complete `Command.Delivery`, and then applies the existing command window, receipt and execution path exactly once. Heartbeats and reconciliation remain independent of command delivery.

## Alternatives considered

**Raise the ordinary WebSocket frame and receive-window limits.** This would permit larger input but would make one unbounded frame consume the bridge's command budget and would not provide ordered recovery when a partial send is dropped. Chunking keeps each wire frame and reassembly buffer bounded.

**Reject input above the original single-frame limit.** This preserves the old implementation but turns valid inline input into an avoidable transport failure and does not solve temporary backpressure for ordinary commands. The protocol now states the larger, bounded contract explicitly.

**Use a new binary transport.** Binary frames could avoid base64 overhead, but they would add another framing and validation path to the existing JSON protocol. The current strict JSON chunk frame keeps the bridge contract versioned and reviewable while retaining the existing receipt exchange.

**Treat a full window as a product quota.** A transient bridge limit is a scheduling and memory bound, not a task-count policy. Cancellable waits preserve work within its deadline without introducing a second product quota or replaying a possibly sent command.

## Consequences

Large inline organization inputs cross the service/member bridge without truncation and settle through the same acceptance, skip, query and unknown-outcome records as small inputs. The service continues to distinguish dropped, enqueued and uncertain sends, and reconnect never replays a partially delivered exchange. A chunked delivery still consumes one command window slot after reassembly; malformed, out-of-order, over-limit or invalid-UTF-8 chunks fail the connection according to the existing protocol policy. Attachments and larger blob synchronization remain separate integrations.

The protocol, service transport, forwarder and resident runtime tests cover 220 KiB input, ordered reassembly, independent reconciliation capacity, cancellation while waiting and existing receipt validation. Package typechecks and focused organization, protocol and runtime suites remain the verification boundary for this change.
