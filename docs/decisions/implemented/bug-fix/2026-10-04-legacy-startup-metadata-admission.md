# Decision Record: Preserve inert legacy startup metadata without blocking SQL admission

Status: implemented

## Problem

A retired JSON runtime can recreate migration ledgers and empty initialization records after a Home has activated SQL storage. Treating every recreated file as conflicting business authority prevents the current runtime from opening an intact database. Reimporting those files would be worse: empty navigation could replace real history, old migration receipts could skip current work, and plugin state could change authority.

## Decision

The regular and deferred storage guards share a bounded, read-only classifier for known startup metadata. It recognizes numeric per-domain migration ledgers only when the SQL domain ledger exists, the strict empty Home navigation initializer only when SQL has that index, and the exact default reclaimed Scope initializer only when SQL records its owning migration. Empty plugin approval/incompatibility arrays and the empty version 2 plugin lock require matching empty SQL state.

All accepted files remain byte-for-byte unchanged and are checked again on every startup. Their values never enter SQL, affect migration completion, replace navigation, create a Scope, or grant permissions. In particular, retired migration names in a recreated ledger are evidence only. Classification does not introduce a persisted format or require a state migration. Fresh JSON imports retain their existing backup, migration, validation and retirement procedure.

Unknown fields, malformed or oversized metadata, nonempty legacy indexes, business records and nonempty plugin state remain fatal. Files are bounded to one MiB, symlinks are rejected, and filesystem or SQL failures propagate. Existing Home ownership and deferred-owner admission remain enforced independently.

## Alternatives considered

**Delete or quarantine recreated files during startup.** This changes the evidence and creates another retirement protocol. Read-only admission preserves both datasets and avoids a filesystem/database commit gap.

**Import every recreated record.** This can overwrite newer SQL state, resurrect deleted data, or install stale grants and migration claims.

**Ignore all JSON after activation.** This conceals real divergent sessions, notes, ownership records and permissions. Admission is restricted to known inert initialization formats.

**Require manual cleanup even for empty startup records.** This leaves a healthy authoritative database unavailable and asks users to decide which files can be removed safely.

## Consequences

Recognized residual metadata remains on disk and costs a bounded read at each startup. Unexpected or genuinely conflicting data still needs explicit investigation. Regression tests combine a released-writer fixture with recreated startup metadata, exercise repeated and deferred admission, preserve SQL and file bytes, reject changed metadata and grants, and retain I/O failures.
