# Decision Record: Preserve Session state under storage pressure

Status: implemented

## Problem

A preparation timeout included the read that determines whether historical preparation exists. Queued reads could classify an ordinary Session as preparing. Catch-all pause reads then treated storage failures as absent state, while result selection could return an earlier root's failed assistant for newly admitted input. Cancelled presentation requests also continued replaying historical execution events.

## Decision

Session access reads the durable locator before applying the preparation budget. Only a locator requiring import starts that budget; quarantined data remains blocked. Pause operations ignore only confirmed missing records and propagate storage failures. Invocation results belong to the latest reply-required root, preserving earlier failed replies as history.

The existing execution request cancellation signal reaches Rollout presentation replay and storage admission. Cancellation stops replay before publishing its discardable checkpoint; recovery and audit still use strict reads. This follows the consumed-signal cancellation approach described by [TanStack Query](https://tanstack.com/query/latest/docs/framework/react/guides/query-cancellation) using the existing AbortSignal and storage queue, without another scheduler or cache.

## Alternatives considered

**Increase the preparation timeout.** Rejected because queue delay still does not establish that import is required. A larger timer merely postpones the same false classification.

**Clear all failure state or hide failed replies on new input.** Rejected because real failures remain evidence. New input clears the appropriate pause through the existing admission path and receives its own execution result.

**Skip cold journal validation.** Rejected because presentation checkpoints must derive from verified committed history. Cancellation bounds abandoned work without weakening integrity checks.

## Consequences

The changes add no persisted format, migration or startup scan. Storage pressure remains observable as storage failure rather than being converted into Session lifecycle state. Focused temporary-store tests cover delayed admission, pause failure propagation, cross-root result isolation, failed-turn input with and without a pause latch, and cancellation followed by successful replay. Large historical-data experiments remain local acceptance evidence, outside CI.
