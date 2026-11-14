# Decision Record: Reuse fixed validators in native writers

Status: implemented

## Problem

Native Message and Part writes repeatedly inspect current Session, epoch and maintenance records and capture durable synchronization facts. Constructing the same literal validator inside each call repeats schema allocation and parser preparation alongside necessary validation. Sampling the real enrolled Runtime's first 100 original Message and Part pairs identifies this work in Core metadata readers, transfer checks, maintenance lookup and native delivery capture. Current records still need fresh validation on every call.

## Decision

Fixed literal validators are constructed once in their owning modules and parsed at their original call sites. Core selector and record fields, epoch index and parent fields, maintenance pointers and delivery identifiers keep their existing strictness, limits, optional fields and failure order. Every original read, current-owner check, mutation guard and SQL publication remains in place.

Runtime-selected Session schemas continue through their original composition facades. Reusing a literal validator does not select an optional owner, retain a record or grant authority. Stored and public Session decoding remain separate; see [Sessions and messages](../../../architecture/session-and-messages.md).

## Alternatives considered

**Cache current owner records.** A preceding write can change a fence in the same transaction. Reusing a metadata or authorization result would weaken the original mutation checks.

**Prevalidate not-ready, message, marker and ready writes together.** Guard callbacks can observe the temporary not-ready state and the published marker between writes. A bulk prevalidation step would change that visibility even if the final SQL commit matched.

**Gate schema-factory calls.** Constructor counts describe an implementation detail. Existing semantic cases, the original capacity failure and profiles of the real native producer assess the change without making that detail a public invariant.

## Consequences

The fixed validators and their compiled parsers remain available for the module lifetime, while record data and Runtime selection remain current. Necessary parsing, storage round trips and background synchronization work still execute; the change does not promise a latency reduction on every host.

The [original capacity case](../../../../packages/organization-runtime/test/capacity-sync.test.ts) retains its 10000-message workload, 240-second append budget and 600-second whole-case guard. Private prefix diagnostics provide attribution and cannot establish capacity acceptance. Measurement and temporary-fixture cleanup follow [Local Performance Experiments](../../../../.synergy/skill/testing-guide/references/local-verification.md#local-performance-experiments).
