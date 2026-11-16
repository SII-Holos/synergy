# Decision Record: Install organization backups through original native owners

Status: implemented

## Problem

Administrators need executable backup and restoration commands. Copying files from a running database does not establish a consistent archive, and importing an old deployment cannot authorize its signer or writers to execute again.

## Decision

The shared organization CLI contributes `backup` and `restore`. Its adapter parses explicit paths, reads a bounded private version-one key file, owns cancellation signals and prints metadata. The backup administration module composes the existing cohort, archive, native Home, Snapshot, checkpoint and inactive-authority owners. It introduces no restoration ledger or execution authorization.

Backup requires an established organization Home and a new encrypted output directory. The original process lock rejects a live competing service. Native maintenance retains all accepted work through capture; the scoped service remains alive until capture and maintenance release settle. The cohort retains its existing version-two inventory; one exported schema validates its writer and administrative reader.

Restoration authenticates the complete archive and verifies supported namespace and facet inventories before opening the target Home. It imports through the original Home installation permit, physical Snapshot installation and checkpoint transaction, retaining their exact adoption receipt. The target Home resolves to its physical canonical directory before native installation. The prepared signing material stays inactive, and exact retries retain the original restoration identity and key.

The command reports `recovery-held` with execution disabled. Current-policy reconstruction, permanent source retirement, writer reconciliation and fresh publication retain their existing owners. Unsupported Hosted or external-resource compositions fail rather than being omitted or relabeled as a complete restoration. Archive extraction alone never reports an executable deployment.

## Alternatives considered

**Copy live SQLite or native files.** This would miss accepted tails, native references and checkpoint integrity.

**Initialize a new ordinary service from imported records.** An old deployment and signer cannot establish current execution authority.

**Reimplement native installation in the command parser.** Domain owners already validate physical provenance and adoption lifetimes. The command uses their administrative composition.

**Recreate signing material on retry.** The owning inactive-authority receipt must retain the first key and exact installation.

## Consequences

The [operations guide](../../../operations/organization-service.md#encrypted-backup-and-held-restoration) documents key input and held restoration. Source and packed child-process tests verify real encrypted bytes, retained signing material, lock refusal, private input rejection and archive authentication before target effects. This command does not establish full multi-namespace recovery or permit Continue.
