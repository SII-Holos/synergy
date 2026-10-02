# Decision Record: Preserve historical runtime snapshot settings

Status: implemented

## Problem

Execution configuration snapshots persist the settings and fingerprint observed by their writer. Reusing the current input schema for their runtime settings rejects evidence produced by a supported earlier writer after an executor is removed. Startup recovery then fails before HTTP admission, and recovery cleanup encounters the same invalid record.

## Decision

`Experiment.Snapshot` uses an evidence-specific runtime schema that retains the known retired executor setting with its original positive integer bounds. `Experiment.Runtime` and `Experiment.File` remain strict current input schemas. Recovery retains the snapshot and fingerprint; task continuation applies frozen task settings while shared resources continue to use live runtime configuration.

The compatibility is limited to the shipped historical executor key. Arbitrary executor names and invalid concurrency values remain rejected. It can be removed only when supported retained snapshots and portable archives no longer contain that writer's configuration.

## Alternatives considered

**Rewrite historical configuration through a migration.** Rewriting committed snapshots changes their evidence and invalidates fingerprints. It also needs to alter or replace immutable journal history, so a read schema is the appropriate repair.

**Restore the executor to current configuration.** This admits an unavailable capability to new configuration and conflates retained observation with supported execution.

**Skip failed recovery owners.** This opens admission without establishing the state of interrupted work and hides an authoritative recording failure.

## Consequences

Existing snapshots remain readable without a storage version upgrade or data rewrite. Recovery tests verify interruption, repeatability and unchanged committed journal events. Configuration tests verify preserved snapshots, live resource selection and rejection by current input schemas. The evidence schema must explicitly cover supported historical writers when current configuration fields are retired.
