# Decision Record: Reuse generation-bound migration access plans

Status: implemented

## Problem

Each selected Session read can prepare its owner migrations and inspect metadata migrations again. Those access paths rebuild the complete registered dependency graph even when registration is unchanged. A live native-writer sample identifies this repeated topological ordering as CPU work separate from storage dispatch. Migration receipts and owner state still require current reads.

## Decision

The central migration access paths retain their dependency-ordered registration snapshot in the owning Runtime, keyed by `MigrationRegistry.generation()`. Both owner preparation and metadata upgrades use it. The registry already copies registered definitions and increments its generation when registration, removal or file-configuration exclusion changes the plan. A failed plan validation is not published. Runtime disposal releases the plan; another Runtime with the same generation has independent registrations.

The retained plan contains only registration metadata and original callback references. Each access receives independent migration objects and copies of their dependency/input-prefix arrays, preserving the existing callback receiver boundary; callbacks cannot modify a later access plan through `this`. Every owner record, condition, migration receipt and transaction-admission check remains in its original path. Store selection, Scope identity, callback effects, dependency order, rollback and missing-receipt conflicts are unchanged. Startup, deferred migration and status planning continue using their existing paths. Existing imported-record transforms already retain their own generation-bound registration plan.

The real-storage access-plan tests observe repeated preparation through the existing migration APIs, count actual delegated plan compilations and retain receipt deletion, rollback, Scope/Store switching, Runtime isolation, registration invalidation and fresh predicate controls. Adjacent migration-order and registry-lock tests retain missing dependency, cycle, released execution policy and registration-copy checks.

## Alternatives considered

**Retain only after registration locks.** This leaves repeated graph work in unsealed fixtures and other supported preparation contexts. The registry generation already names every supported metadata change before locking.

**Cache prepared owners or successful conditions.** Receipts can be removed, rolled back or absent in another Store, and conditions can change with current records. Such results cannot authorize a later owner access.

**Change dependency ordering.** Replacing its comparator or ordering algorithm would widen the semantic change. Reusing an unchanged validated plan preserves the current topology, version and lexical rules.

## Consequences

Repeated access in one unchanged Runtime avoids repeated graph construction and sorting. Registration changes still validate their complete current graph before access, and plan storage is bounded by the selected registration set. No persisted format, product timeout, migration receipt, authority decision or workload budget changes. A focused work bound and a sampled hotspot do not establish whole-workload capacity acceptance; the original complete workload remains required.
