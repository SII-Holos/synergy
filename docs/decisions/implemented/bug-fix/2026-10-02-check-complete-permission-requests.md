# Decision Record: Evaluate the complete permission request before prompting

Status: implemented

## Problem

A permission request can include several independently scoped patterns. An early prompt can complete without evaluating a later target's denial, making the result depend on target order.

## Decision

PermissionNext evaluates all request patterns before creating a pending request. Any effective denial rejects the complete request. Otherwise one prompt covers the complete pattern set when a target requires a decision or mandatory metadata requires confirmation. Fully allowed requests retain their direct completion.

## Alternatives considered

**Sequential prompts.** They can admit an incomplete request and do not represent the caller's atomic intent.

**Host-specific target checks.** They do not protect generic callers of the public permission service.

## Consequences

Pattern order cannot change denial or prompt admission. Focused regressions cover both orders and ordinary or mandatory confirmation. Rule precedence, reply semantics and cancellation remain owned by their existing service.
