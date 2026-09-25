# Decision Record: Complete Kanban message window snapshots

Status: implemented

## Problem

Kanban can receive a successful message page while its pane remains loading because readiness requires message-window metadata. Tests that report snapshot presence through a separate flag conceal this incomplete store update.

## Decision

The Kanban board loader reconciles window metadata from the accepted latest-page plan in the same batch as messages, parts, and the latest Context projection. Empty pages establish loaded snapshots as well. Store types distinguish window metadata from the complete planning state. Regression tests inspect a real Solid store through the canonical snapshot predicate.

Pane errors expose a local retry with concise guidance and collapsed diagnostics. Retrying one pane preserves the other panes and the loader's existing freshness and retention rules.

## Alternatives considered

**Consider a present messages array sufficient.** An array alone cannot represent the loaded page's mode, cursors, totals, or snapshot provenance, especially when events created the bucket.

**Track readiness separately in the pane.** A second state source can diverge after eviction, navigation, or rejected responses and leaves metadata incomplete for other consumers.

## Consequences

Kanban uses the same persisted-in-memory message-window semantics as the session reader. The real-store fixture verifies successful empty and nonempty loads, navigation reuse, and eviction behavior without granting readiness independently of the store.
