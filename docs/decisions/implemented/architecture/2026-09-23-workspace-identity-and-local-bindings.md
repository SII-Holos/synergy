# Decision Record: Workspace identity and local bindings

Status: implemented

## Problem

A directory string cannot identify working files independently of their location. Concurrent registration, moving a directory, importing another host's history, and reusing a former pathname require distinct outcomes.

## Decision

The Harness Workspace catalog owns stable identities and transactional location indexes. Each local binding names a host namespace, path, optional filesystem identity, and generation. Rebinding requires the expected record revision, preserves the Workspace ID, and advances its binding generation. A conflicting destination or replaced directory requires an explicit operation instead of silently adopting different files. Cross-Scope lookup is unavailable to callers.

Runtime hosts explicitly supply local location identification. Runtime Local uses a persistent private namespace identity and filesystem directory identities; hosts without local file capabilities can omit that dependency. A record revision orders metadata changes, while a binding generation invalidates work resolved against a previous location.

## Alternatives considered

Deriving Workspace IDs from absolute paths would change identity on a move and conflate equal paths on different hosts. Keeping a path in every Session would leave multiple mutable owners of the same binding. Neither supports an atomic destination uniqueness check.

## Consequences

Local bindings and their indexes are persisted separately from Session history. Consumers must resolve an explicit Workspace and retain its generation for execution. A directory that is missing or has been replaced cannot be made usable merely by finding another directory at the stored pathname.

## Verification

Catalog tests exercise concurrent registration, host separation, generation rejection, cross-Scope lookup, and stale conditional updates against real SQLite. Filesystem tests verify persistent namespace convergence and directory replacement with real temporary directories.
