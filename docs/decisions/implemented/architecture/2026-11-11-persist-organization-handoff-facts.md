# Decision Record: Persist organization handoff facts independently

Status: implemented

## Problem

Changing a Session's driver after a timeout can authorize two executors. Human consent, source surrender, organization commit and destination publication are distinct facts with different owners and cannot be inferred from connection status.

## Decision

The organization coordinator reserves a monotonically increasing destination epoch and locks the canonical Session directory in the same transaction as current authorization and its command sequence barrier. The current member driver, or creator of hosted work, initiates the operation. A destination member accepts the exact mapping revision. A different member can receive only a shared Session.

Persist signed source freeze, destination preparation, source surrender, cancellation, destination activation and permanent retirement facts under one immutable handoff identity. Proofs bind deployment, Session, both machines, epochs, mapping revision, sharing generation and frozen manifest. The existing service signing authority issues surrender and activation permits in separate transactions. Activation authorizes paused publication only; it never authorizes Continue or a model call.

Cancellation keeps the directory locked until the source proves its local cancellation choice. A late surrender proof may reveal that the source irreversibly surrendered before a cancellation request arrived. That fact wins over the pending request. Source disappearance after proven surrender does not prevent reconciling the same destination. Activation and never-activate retirement are permanently mutually exclusive; an unknown result never selects another executor.

## Alternatives considered

**Use heartbeat expiry as surrender.** Liveness cannot prove that an existing process or delayed command stopped.

**Commit and activate in one service operation.** The service cannot atomically publish another process's Session storage and cannot infer that publication from a successful dispatch.

**Unlock on cancellation request.** The source may already have surrendered and its response may be delayed; the source's durable proof must arbitrate the race.

## Consequences

The coordinator and machine proof recovery channel preserve separate durable facts and current human authorization. Tests use real organization SQL and two authenticated WebSocket connections to verify consent, command/share exclusion, monotonic epochs, cancellation and proof races, source disconnect, idempotent commit and separate activation. This coordinator does not itself export Session data, freeze physical writers or publish destination storage; those remain Runtime and portable owner responsibilities.
