# Decision Record: Preserve recorded executor limits independently of active configuration

Status: implemented

## Problem

Execution snapshots record runtime settings and their fingerprint. Retiring an executor narrows accepted live configuration but cannot invalidate the executor names already present in retained run journals. Parsing recorded limits through the active executor enum prevents recovery before HTTP admission.

## Decision

`Experiment.Snapshot` uses a recorded runtime schema whose executor-concurrency keys are nonempty strings. Limit values retain the same positive integer bounds as active configuration. Other runtime fields and the snapshot envelope retain their existing validation.

Live runtime configuration and experiment-file inputs retain the supported executor enum. Snapshot capture still resolves runtime settings through the active schema, and applying a historical task snapshot uses live resource settings. Historical keys are evidence only; they neither register executors nor grant execution authority.

The stored version, keys, values, journal and fingerprint remain unchanged, so no persisted-state rewrite or migration is required. Generated API contracts expose the recorded dictionary separately from active input configuration.

## Alternatives considered

**Remove retired keys in a migration.** This changes the recorded configuration and invalidates its historical fingerprint, including immutable journal entries and exported archives.

**Restore retired executor names to active configuration.** This accepts new settings for a resource the runtime cannot provide.

**Accept arbitrary configuration snapshots.** This removes useful validation beyond the executor taxonomy that caused the incompatibility.

## Consequences

Recovery can read and settle historical runs while preserving their original configuration. Schema validation still rejects malformed limits, unsupported snapshot versions and unrelated fields. Tests cover real journal recovery, historical revision reads, repeat recovery, live-input rejection and applying a snapshot without replacing live executor limits. Other future configuration retirements still need an explicit review of recorded evidence.
