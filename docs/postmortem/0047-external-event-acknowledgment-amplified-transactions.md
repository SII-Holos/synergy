# External event acknowledgment amplified transactions

## Executive summary

A PostgreSQL embedding regression exceeded its test deadline after model and Session work completed. The external event pump opened a durable transaction for every acknowledgment. A bounded batch now commits its accepted prefix together, with unchanged receiver deduplication and per-record revision checks.

## Summary

A synthetic three-turn conversation reproduced slow completion with a local model fixture. Phase measurements separated inference, Session settlement and external delivery. Two pumps of about forty events each spent about eleven seconds acknowledging records; extending the test deadline did not resolve the cause.

## Timeline

- On 2026-10-05, repeated PostgreSQL CI failures prompted a local lifecycle reproduction.
- Phase measurements isolated delivery acknowledgment after successful Session work.
- SQLite and PostgreSQL tests covered partial delivery failure and atomic revision-conflict rollback.

## Root cause

The embedding integration's queue bounded the number of delivered records but acknowledged each with a separate durable transaction. Network acceptance and database acknowledgment are distinct boundaries; batching the former did not bound the transaction overhead of the latter. This is an integration interface defect, not an observed defect in the pinned official runtime.

## Guardrails added

- [Event sink tests](../../packages/harness/test/storage/event-sinks.test.ts) retain accepted records until acknowledgment, preserve a failed suffix and roll back all acknowledgments on a changed revision.
- The [delivery decision](../decisions/implemented/architecture/2026-10-01-durable-external-event-sinks.md) records the bounded replay tradeoff.
- The [persistence workflow](../../.synergy/skill/change-persistence/SKILL.md) requires phase evidence before changing behavioral deadlines.

## Lessons

An end-to-end timeout does not identify its slow owner. Measure inference, settlement and durable delivery independently, and preserve failure semantics when reducing transaction count.
