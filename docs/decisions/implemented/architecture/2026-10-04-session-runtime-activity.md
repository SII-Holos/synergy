# Decision Record: Publish structured current session activity

Status: implemented

## Problem

A generic busy flag and raw provider description cannot distinguish workspace file preparation, model waiting and tool execution. Process headers inferred action from loaded Parts, so collapsing or evicting content changed the visible status.

## Decision

The existing session status contract carries structured activity. Its loop generation and bound root fence updates, and scheduler callbacks count actual active calls. Worker admission separates resource waiting from model waiting. File preparation is announced before its blocking snapshot capture. Shared UI translates this metadata for process headers and runtime hints; diagnostic descriptions do not supply phase labels.

## Alternatives considered

**Infer phases from rendered Parts.** Lazy and virtualized history lacks the current evidence, and a tool Part can precede actual scheduler execution.

**Add another activity stream and store.** A second authority would require independent snapshot and replay reconciliation. The existing sequenced status stream already owns live session state.

## Consequences

Collapsed status remains accurate without loading tool bodies. Phase changes preserve their start time until the real stage changes, and late work cannot overwrite a successor or stopping owner. Producers must report meaningful operation boundaries. Missing structured metadata uses a neutral processing label. Activity is ephemeral and requires no storage migration.
