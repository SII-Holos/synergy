# Decision Record: Rollout migration validates the session fields it owns

Status: implemented

## Problem

Rollout evidence migration runs before the server accepts requests. Validating historical session metadata against the entire current session schema makes startup depend on fields unrelated to evidence migration. Historical channel records can contain a nullable sender name, and archived sessions can retain a retired endpoint variant. Parsing and writing the full current schema can also discard unknown historical metadata when adding a Cortex settlement timestamp.

## Decision

The existing versioned rollout migration validates only Cortex status and settlement time in session metadata, using the canonical field definitions and preserving unrelated fields at both the session and Cortex levels. This validation runs before modifying messages or recording artifacts. Historical endpoint metadata remains intact; current session and API schemas remain unchanged.

The migration keeps its existing identifier, per-session audit, and central completion checkpoint. Retrying an interrupted upgrade skips completed sessions and processes the remaining records with the corrected input validation. Invalid owned fields and storage errors still fail migration rather than marking incomplete work successful.

## Alternatives considered

**Accept historical endpoints in the current session schema.** That broadens the live API solely to accommodate migration input and restores a retired source variant to the product model.

**Rewrite or delete unrelated endpoint metadata.** Rollout evidence migration does not own endpoint conversion, and archived source metadata remains historical evidence.

**Skip every session that fails full-schema validation.** That permits startup without migrating its accounting and retained outputs, hiding incomplete work behind a successful migration checkpoint.

## Consequences

Historical source metadata does not prevent evidence migration. Tests cover nullable sender names, archived endpoints, unknown metadata preservation, invalid owned fields before writes, repeated execution, and the central startup migration runner. The migration does not repair unrelated metadata or reconstruct information absent from historical records.
