# Decision Record: Keep member bridge control traffic live

Status: implemented

## Problem

A native continuation or cancellation can wait for execution to drain. Serially awaiting its callback in the member socket's frame queue prevents heartbeat acknowledgments and receipt queries from being processed. The connection can report offline while its transport and execution owner remain available.

## Decision

Frame parsing, handshake validation and heartbeat updates remain ordered. Verified command frames enter independently tracked callbacks with separate command and query/skip windows. Each window admits at most 16 callbacks and 256 KiB of original frame bytes. The existing raw-frame bounds remain independent. Durable native sequence checks own effect ordering; callback completion order is not authority.

Saturation returns a correlated `SERVICE_UNAVAILABLE` reply with `not_dispatched` before invoking the receiver, without closing the socket. The service stores this explicit refusal as not dispatched, redacts its message, and retains query/skip requirements for explicit retry. Ordinary command saturation cannot consume reconciliation capacity. Duplicate active exchange IDs fail the connection. Completion releases count and byte capacity; every close path drains all admitted callbacks, including work that outlives its transport.

## Alternatives considered

**Extend heartbeat deadlines.** A larger timeout still blocks query and skip behind the very operation they must reconcile.

**Dispatch without limits or disposal ownership.** This removes the immediate stall but allows unbounded retained payloads and late callbacks after Runtime storage closes.

**Close a healthy connection when callback capacity fills.** Long admitted operations can outlive their HTTP waiters. Later active requests may legitimately arrive while those operations remain pending; capacity pressure is not protocol corruption.

## Consequences

Long controls preserve transport liveness and independent reconciliation. The bridge retains bounded concurrent work and no persistent dispatch queue. Disconnect still fences new reception and never withdraws already committed native work. Frame schemas and SDK contracts are unchanged.

Real WSS tests hold a control beyond the offline interval while querying and observing heartbeats, saturate count and byte windows, reuse released capacity, reject duplicate exchanges and verify close waits for callback completion. Service tests prove an explicit capacity refusal remains unsent and retries only through query and skip. The [postmortem](../../../postmortem/0098-member-command-blocked-control-traffic.md) records the observed failure.
