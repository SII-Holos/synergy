# Decision Record: Remove runtime initial history fingerprints

Status: implemented

## Problem

Starting an execution segment enumerated every historical message body and hashed it before recording the segment. This work bypassed the model working-set cache and grew with unrelated retained history. No execution, recovery, permission or input-selection consumer uses the resulting optional fingerprint.

## Decision

Segment admission records its actual input and parent identity without producing an initial-history fingerprint. Calls, requests, responses, tools, usage and journal integrity remain recorded by their existing owners. Historical Run records retain the optional field in the read schema so immutable journal replay and portable archives preserve their evidence.

## Alternatives considered

**Concurrent hashing:** reduces some scheduling overhead but still reads all historical bodies before execution.

**Background or incremental fingerprints:** adds derived state and lifecycle work without an identified consumer.

**Rewriting old records:** removes retained evidence and requires historical journal migration without improving new execution admission.

## Consequences

New runs omit an unused auxiliary digest. Their actual execution evidence is unchanged. The production-start regression rejects any historical stream traversal during segment bookkeeping; historical schema acceptance remains covered separately. End-to-end startup latency depends on other preparation stages and is measured separately from this work reduction.
