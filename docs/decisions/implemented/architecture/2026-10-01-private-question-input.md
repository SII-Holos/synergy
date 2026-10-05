# Decision Record: Private Question input and cancellation

Status: implemented

## Problem

Embedded business tools need direct inputs and can receive a private value without echoing it into events, logs or model output. Their pending questions must also stop when the owning tool is cancelled.

## Decision

Question input declares optional allow_custom and input_type metadata. Password input is delivered to the awaiting host caller, while lifecycle replies and the generic Question tool output redact its value. The API accepts an optional AbortSignal and removes a cancelled request before rejecting its caller, so a late reply cannot complete it.

## Alternatives considered

A host-specific Question store duplicates interaction lifecycle. Removing private fields loses the business input contract. Redacting only the generic output leaves lifecycle events and logs exposed.

## Consequences

Ordinary Question schemas and answers retain their behavior. Private callers must consume values without placing them into their own tool results, and clients must honor the input metadata. The generic tool never returns a password reply to the model. Cancellation is explicit and independent of the timeout setting.
