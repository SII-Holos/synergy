# Decision Record: Commit permission rules before replying

Status: implemented

## Problem

A failed Always allow write removed the pending request and updated the rule cache before persistence, leaving the caller without a retryable request and potentially applying an uncommitted grant.

## Decision

Write all patterns in one storage transaction and publish the cached rules only after commit. Serialize replies per Session, retain failed requests, and await replies on both HTTP routes.

## Alternatives considered

Restoring a request after failure cannot undo an already-published completion event or partial cached grant. Updating only the UI cannot repair the domain promise.

## Consequences

Control profiles, pattern matching and the four permission decisions retain their meanings. Focused tests inject failed storage and verify pending requests and effective grants before a successful retry.
