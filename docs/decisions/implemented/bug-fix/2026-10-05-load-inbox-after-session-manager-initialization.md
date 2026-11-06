# Decision Record: Load Inbox when Session management needs it

Status: implemented

## Problem

The public Session history entry can be loaded before the Session facade. SessionManager eagerly imports Inbox, which imports that facade; the facade reads history function exports before history has initialized. Hosts that select this entry independently fail during module loading, while broad suites can mask the cycle through their import order.

## Decision

SessionManager loads Inbox inside its asynchronous scheduling, delivery and fenced-release operations, matching its existing deferred Drive and Invoke dependencies. Module initialization exposes lifecycle state without loading the higher-level input pipeline. History continues to own rollback validation and implementation, and the Session facade retains the same callable exports and schemas.

## Alternatives considered

Preloading the Session facade in embedding hosts or changing test order would retain the import-order requirement. Duplicating history schemas and wrappers in the facade would create another maintenance surface without correcting the lifecycle dependency.

## Consequences

Each affected operation resolves the cached Inbox module when needed. Independent subprocess imports cover history and Session, while rollback, Inbox admission and wake-retry tests verify the existing behavior. No persistence format, migration or product capability changes.
