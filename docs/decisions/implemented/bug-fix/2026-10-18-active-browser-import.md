# Decision Record: Import from an active browser

Status: implemented

## Problem

An open Chromium password database can hold an exclusive SQLite lock even between writes. Ordinary read-only connections cannot read it. Cookie expiry values use microseconds since 1601 and exceed JavaScript's exact integer range, so Node SQLite can reject valid rows before import. Collapsing acquisition failures into unavailable or access errors hides the cause and gives misleading recovery instructions.

## Decision

Desktop copies the selected database and any rollback journal or WAL into a private temporary directory before opening SQLite. Open source handles remain read-only, reject symbolic links and must match their discovered path identities. Size, modification and change timestamps must remain stable across the bounded copy; missing or newly appearing sidecars also invalidate it. SQLite recovers and checks only the private copy before a query-only transaction. Unstable or invalid acquisitions retry at most three times, and every exit removes temporary files. This supersedes only the direct database acquisition choice in [Browser source import](../feature/2026-09-29-browser-source-import.md); its authorization, data ownership and supported-format rules remain in force.

Cookie expiry is selected as decimal text and parsed as a signed-64-bit-bounded nonnegative BigInt. Conversion to Unix seconds occurs before conversion to Number, retaining subsecond precision without the SQLite Number overflow.

Import results distinguish access, source unavailability, sustained changes, unsupported format/encryption, size limits and failed integrity checks. A failure before records were read displays an explicit failed state. Desktop records fixed categories, phase, SQLite numeric code, attempt and aggregate counts in its private browser import log; raw errors, paths, website addresses and credentials are excluded.

## Alternatives considered

**Require closing the source browser or use SQLite online backup.** An exclusive source connection prevents both ordinary read-only queries and SQLite backup. Closing the browser remains a recovery option when writes prevent a stable copy, rather than a prerequisite.

**Copy only the main database.** Committed WAL pages or an unfinished rollback transaction can make the main file alone incomplete. Acquisition includes the relevant sidecars and validates the recovered copy, following the SQLite backup constraints cited beside the implementation.

**Ignore SQLite locking in a source connection.** This can read across concurrent writes and would require a custom VFS or weaker immutability assumptions. The private-copy approach confines recovery and SQLite writes to disposable files.

## Consequences

An idle open browser can be imported without changing its database or lock. Continuous writes can still exhaust the bounded retries. Temporary encrypted browser data uses up to 256 MiB per acquisition and is deleted on completion, cancellation and failure; a process crash can leave a private temporary directory. No browser process is stopped and no Keychain protection changes. Native separate-process lock tests, rollback/WAL fixtures and Electron large-expiry tests cover the storage behavior; rendered tests cover actionable results without false all-zero success counts.
