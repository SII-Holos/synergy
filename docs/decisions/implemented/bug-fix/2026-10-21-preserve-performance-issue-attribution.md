# Decision Record: Preserve performance issue attribution

Status: implemented

## Problem

Slow span completion reads undeclared module threshold keys and falls back to the global threshold instead of using the configured family threshold. Completed tool duration also shares the idle-stall issue code. Default issue fingerprints combine Scopes, while repeat observations update evidence but leave their displayed description and trace attribution attached to the first occurrence. Passing undefined attribution into context merging can erase the ambient Scope before aggregation.

## Decision

[Span completion](../../../../packages/harness/src/observability/spans.ts) uses the declared HTTP, Session, LLM, tool and storage duration thresholds, with the global duration threshold for other modules. Total tool duration raises `PERF_TOOL_SLOW_EXECUTION`; the tool resolver retains `PERF_TOOL_STALLED` for actual idle activity detection. [Performance presentation](../../../../apps/web/src/components/performance/presentation.ts) distinguishes slow execution from stalled execution without changing long-task policy or introducing first-token alerts.

Span creation and [issue creation](../../../../packages/harness/src/observability/issues.ts) compact unspecified fields before merging with ambient context. Completion raises its issue under the captured span context and explicitly supplies its Scope, Session, message, call and request attribution.

Default fingerprints use `code:module:scope:<scopeID>` or `code:module:global`; Session and call identity do not create additional aggregates. Custom fingerprints remain owner-controlled. The [single issue UPSERT](../../../../packages/harness/src/observability/db-writes.ts) updates severity, title, message, recommendation, attribution and evidence together with the latest observation. The original issue identity, creation time, ISO timestamp and first-seen time remain unchanged; occurrence count accumulates and last-seen time advances.

The observability startup migration `20261021-observability-issue-scope-attribution` depends on `20260814-observability-metric-slim-v6` through the existing central registration. It acquires SQLite write ownership and suppresses only open rows whose fingerprint exactly equals `code:module`. It retains their identities, timestamps, lifetime counts and evidence, adding an explicit reason that historical Scope attribution cannot be reconstructed. It neither splits historical counts nor marks the underlying condition resolved. Distinct custom fingerprints and terminal rows remain unchanged. The upgrade changes data only, so schema version 6 and table definitions remain unchanged; an empty installation retains lazy database creation.

## Alternatives considered

**Keep one global aggregate or only refresh evidence.** These retain cross-Scope contamination or leave the visible title and trace inconsistent with the latest observation.

**Include Session or call identity in default fingerprints.** These create high-cardinality rows instead of one aggregate per issue family and Scope. Owners can still choose a custom fingerprint when their domain requires different grouping.

**Reconstruct historical Scope counts or resolve old rows.** The old default fingerprint does not retain enough evidence to divide lifetime counts reliably. Resolution would falsely assert that the observed condition ended; suppression records attribution uncertainty instead.

## Consequences

Open aggregate descriptions and drill-down identities describe the latest observation, while timestamps and counts retain their lifetime meaning. Default cardinality grows with Scopes rather than individual executions. Legacy aggregates remain available as suppressed diagnostic evidence and stop contributing as open pressure; future observations create Scope-aware aggregates. A custom fingerprint deliberately identical to the retired default cannot be distinguished from that default in retained data.

The existing [span tests](../../../../packages/harness/test/observability/spans.test.ts), [issue tests](../../../../packages/harness/test/observability/store.test.ts), [startup migration tests](../../../../packages/harness/test/observability/startup-migration.test.ts) and [presentation tests](../../../../apps/web/test/components/performance/presentation.test.ts) cover custom threshold boundaries, captured and ambient attribution, latest aggregate fields, low-cardinality Scope separation, fresh installation, released-ledger upgrade, repeated migration and preservation of custom rows.
