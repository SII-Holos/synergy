# Decision Record: macOS shell selector and readable-root metadata

Status: implemented

## Problem

macOS deny-default sandboxes could not read the `/bin/sh` selector, and Git could not stat ancestor components of an explicitly readable repository path. The original worktree Git-directory proposal also exposed shared executable configuration and hooks while preventing index, object and ref writes.

## Decision

- Add `/var/select` and `/private/var/select` to macOS developer read roots so `/bin/sh` can select its implementation. Linux roots remain unchanged.
- Grant `file-read-metadata` on canonicalized ancestor components of readable roots. This permits stat operations without granting directory listing or data reads.
- Keep original-checkout Git metadata outside implicit sandbox grants. Ordinary external reads retain their existing permission flow. Shared Git metadata requires a separate design covering executable integrations, actual common-directory resolution and narrowly scoped writes before it can be granted automatically.

## Alternatives considered

Granting full ancestor reads exposes directory listings. Trusting the original checkout grants unrelated writes and execution. Making the whole shared Git directory read-only still permits executable integrations while breaking normal index, object and ref updates. None is required for the two macOS fixes.

## Consequences

The shell selector and ancestor metadata gaps are fixed for already-authorized roots. This change does not claim to restore automatic Git access for linked worktrees. Tests preserve the original-checkout authorization boundary and verify macOS-only selector roots plus metadata-only ancestor permissions.
