# Decision Record: Forward active organization inputs with explicit receipt recovery

Status: implemented

## Problem

Service authorization and native Inbox reception commit independently. A lost acknowledgment cannot establish that an input failed, while retrying a retained body after reconnect can execute work without a current user request. A transport enqueue also cannot be classified as a dropped frame merely because it reports backpressure.

## Decision

The authenticated machine bridge carries bounded input, receipt-query and skip exchanges. Resident member connections create their receiver from the verified signing identity and connection epoch, bind callbacks to the owning Runtime context and pass connection cancellation to the native commit guard. Provisioning-only connections omit command capability.

The service serializes active requests by Session and retains bounded in-memory payloads only while those requests run. It persists authorization and transport facts independently of Runtime results. A dropped native send is definitely unsent; an enqueue is sent once, and an exception or lost receipt retains uncertainty. Late validated receipts update the original durable attempt even after the HTTP caller stops waiting.

An explicit retry validates immutable identity and current visibility before querying the original signed attempt. Query can observe an expired permit without admitting execution. Confirmed absence or rejection requires a separately signed skip before fresh authorization. Read-only HTTP lookup performs no skip or input delivery. Restart and reconnection do not enumerate stored admissions as executable work.

HTTP returns 202 only after native durable acceptance, 200 for an existing effect, 503 for definitely unsent unavailability and 504 with the original logical request ID for uncertain delivery. Human receipt reads recheck current access and omit signing credentials. The separate generated organization SDK describes these outcomes.

## Alternatives considered

**Automatic retries on transport errors.** An enqueue or exception may already have reached the Runtime. Repeating the payload obscures uncertainty and can extend an old authorization into a new connection.

**Using query absence to authorize a new sequence immediately.** A delayed old frame still needs a durable skip fence. Native skip competes atomically with that frame before the next sequence proceeds.

**Cancelling Inbox work with the HTTP request.** A caller's timeout cannot retract an independently committed input. HTTP cancellation ends transport waiting; the Runtime retains its accepted work.

## Consequences

Tests exercise native send outcomes, late replies, cancelled waiting callers, current authorization, schema validation and mounted OpenAPI. Presets integration uses the generated HTTP client, authenticated WebSockets and independent service/Runtime databases to inspect the actual Inbox, deduplication and skip ordering. The bridge adapter has separate verified-WSS tests.

The exposed command is bounded text input to an existing bound Session. Session creation, control operations, attachments and execution/resource grants remain separate owners. Command reception does not open the member execution source. The [organization architecture](../../../architecture/organization.md#online-command-forwarding) defines the current behavior.
