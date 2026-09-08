# Decision Record: Snapshot Git initialization compatibility

Status: implemented

## Problem

Snapshot storage requires SHA-1 object IDs, but selecting the format with a newer Git command-line option prevents initialization on Git 2.25.1. A generic storage error conceals the underlying command failure, and accepting an existing repository without validating its object format can publish incorrect repository metadata.

## Decision

`SnapshotStore.initializeBareRepository()` uses bare initialization with an explicit `GIT_DEFAULT_HASH=sha1` override through the sanitized snapshot subprocess environment. Older Git retains its SHA-1 behavior; newer Git receives an explicit format selection. Before configuring the repository or publishing its metadata, initialization hashes an empty tree and checks the result against the snapshot SHA-1 object-ID schema. Existing repositories with another object format are rejected without conversion or deletion.

Initialization failures retain the Git exit code and stderr in the storage error message and structured cause. Failed initialization does not publish repository metadata, so removing a filesystem obstruction allows a later attempt to succeed. The same initialization owner serves session capture, archive transfer, and snapshot maintenance.

Snapshot index exclusion uses `git update-index --force-remove -z --stdin` for literal paths. Git 2.25.1 does not support `git rm --pathspec-from-file`; the index command accepts NUL-delimited input without changing workspace files or interpreting filenames as wildcard pathspecs. Existing historical objects and retention refs remain intact.

## Alternatives considered

**Require a Git upgrade.** Upgrading remains a valid operational remedy, but initialization can preserve the required object format without forcing a version change on otherwise usable installations.

**Retry without the option after parsing an unknown-option error.** This introduces a second initialization path and depends on diagnostic wording. An environment override works without version probing or an error-driven retry.

**Remove explicit format selection.** User defaults could then produce SHA-256 stores whose object IDs do not satisfy snapshot ownership and retention rules.

## Consequences

Initialization adds one read-only Git hash operation before recording success. No persisted format or migration changes are required. Regression tests cover writable stores, repeated initialization, inherited hash defaults, rejection of incompatible repositories, detailed failures, and retry after an obstruction is removed. Compatibility verification must exercise the snapshot operations with an actual older Git executable; passing current-Git tests alone cannot establish older-Git support.
