# Decision Record: Reconcile terminal Blueprint references with canonical metadata

Status: implemented

## Problem

A retained terminal loop can have a canonical Note reference without its legacy source field. Public Note projections hide that unresolved reference, so recovery can miss the cleanup and later expose the stale reference after source catch-up. Clearing from a projected read also risks replacing a newer loop selected before the write.

## Decision

The Note owner supplies a readonly metadata inspection callback over a cloned current document in one Storage snapshot. It preserves original Scope resolution and kind availability. Blueprint exposes only an expected-loop predicate to its selected recovery owner; ordinary public Note projections remain unchanged.

Preview uses that predicate without writes. Applying cleanup compares the expected active loop inside the original Note metadata transaction and reports a change only when that comparison succeeds. Missing Notes produce no cleanup effect; other storage errors remain observable. The original metadata writer retains the new exact version without changing earlier immutable versions. Recovery still requires the loop's registered source owner.

## Alternatives considered

**Expose unresolved references through public projections.** This would weaken optional-owner visibility to repair an internal maintenance read.

**Read through a mutator during preview.** This unnecessarily acquires writer ownership for an observation.

**Clear unconditionally after reading.** This can erase a newer active loop and produce an inaccurate recovery report.

## Consequences

Preview reports the planned cleanup from its captured metadata; publication still performs an independent atomic comparison. Scope resolution, unavailable kinds, cloned inspection, stale comparisons and exact retained versions have owning regressions. The public recovery regression covers the hidden legacy reference through both preview and application.
