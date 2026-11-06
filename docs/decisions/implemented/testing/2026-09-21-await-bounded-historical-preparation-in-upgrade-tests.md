# Decision Record: Await bounded historical preparation in upgrade tests

Status: implemented

## Problem

The activation regression expected the first historical access to finish synchronously. A loaded CI runner instead exercised the intended 1.5-second foreground budget and returned `SessionPreparingError`, failing an otherwise valid upgrade even though preparation continued.

## Decision

The activation test handles only the typed preparing outcome and waits for the same owner import to finish before checking convergence and store integrity. A separate fixture holds an owner-local migration behind an explicit release, requires the foreground call to return the preparing outcome, and then releases the import. Startup admission and unrelated-history assertions remain unchanged.

## Alternatives considered

**Increase the product preparation deadline.** This would slow foreground failure feedback to accommodate a test assumption rather than a product requirement.

**Retry CI until a fast runner passes.** That leaves valid intermediate behavior untested and keeps correctness dependent on runner load.

## Consequences

The test no longer treats the documented intermediate state as a failed import. Other errors remain fatal, the blocked-owner fixture proves bounded foreground behavior, and the existing outer test timeout still detects preparation that never converges. Product timing and storage behavior are unchanged.
