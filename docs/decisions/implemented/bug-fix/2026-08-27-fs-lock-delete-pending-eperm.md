# Decision Record: fs-lock acquisition treats Windows delete-pending EPERM as contention

Status: implemented

## Problem

`acquireFileLock` takes the lock with an exclusive create — `fs.open(filename, "wx", 0o600)` — and treats every error other than `EEXIST` as fatal. On Windows, when a releasing owner unlinks the lock, the directory entry stays delete-pending until the last handle to the file closes, and any new open against that entry fails with `ERROR_ACCESS_DENIED`, which surfaces as `EPERM` rather than `EEXIST` ([DeleteFile semantics, Microsoft Learn](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-deletefilew); libuv maps the status to `UV_EPERM`). So under genuine contention the next acquirer aborts with a raw `EPERM` instead of retrying — a correctness failure of the lock API on Windows, masked until the start-identity reclamation (#1265) added a real 12-worker contention test. The same test code flaked on CI exactly this way: red at 10:04Z, green at 11:42Z, red at 12:04Z, each failure `EPERM: operation not permitted, open '<...>.lock'` at `fs-lock.ts` acquireFileLock.

## Decision

The acquisition loop now treats `EPERM` from the exclusive create as contention, identical to `EEXIST`: the create's own error handler takes the stale-owner snapshot path and retries on the normal cadence, and the existing top-of-loop timeout check bounds the loop so a persistent `EPERM` (a directory ACL that genuinely denies creation) still fails within `timeoutMs` with the lock's own timeout error instead of a raw crash. The tolerance is scoped to the create alone — an `EPERM` from `handle.writeFile()` or `handle.close()` after the create succeeded stays a caller-visible failure with the original error, preserving the pre-change semantics for post-acquisition I/O instead of misreading them as contention (which would leave the acquirer waiting on its own live lock until timeout). The rule carries `Provenance:`/`Local adaptation:` markers beside the create per the external-provenance decision record. Coverage lives in `packages/util/test/fs-lock-delete-pending.test.ts`: the platform state cannot be produced on demand on macOS or Linux, so the test simulates it at the fs boundary with a proxy over `node:fs/promises` that throws `EPERM` for one lock path, asserting transient recovery, bounded timeout, and that write/close failures surface their original error. The module-level replacement is restored in `afterAll` per the testing-guide rule for process-global replacements in shared shard processes.

## Alternatives considered

**Gate the retry on `process.platform === "win32"`.** Rejected: the platform branch buys nothing — treating the extra code as contention is harmless on POSIX, where `EPERM` from an exclusive create is already an "entry not creatable now" signal, and a platform-conditional error contract is the kind of branch that rots when the next Windows mapping (AV/indexer `EBUSY`, per the #1247 history in the start-identity record) needs the same tolerance.

**Weaken the contention test to tolerate `EPERM` on Windows.** Rejected: the flake is the product failing under contention, not an over-strict test. Skipping or retrying around the assertion would leave every Windows caller — credential store, Holos accounts, migration-log merges — one release race away from a thrown `EPERM` in production.

**Tolerate `EPERM` for the whole acquire sequence, not just the create.** Rejected: an `EPERM` from the payload write or the handle close after the create succeeded is an I/O failure of this acquirer's own operations, not evidence the lock is held elsewhere. Retrying it would re-enter the loop against a lock file this process just wrote — a live owner by its own pid — and spin to timeout while leaving the original error (and the leftover lock) undiscovered.

**Change release to a rename-vacate that avoids delete-pending.** Rejected: read-compare-unlink release is itself a deliberate decision in [fs-lock stale-owner reclamation](./2026-08-27-fs-lock-pid-recycling-start-identity.md); rename vacates the canonical path and can displace a successor's fresh lock, reintroducing the overlapping-critical-sections bug that record fixed.

## Consequences

Contended acquisition on Windows now resolves by retry like every other contention signal, and the CI flake's root cause is closed rather than retried around. The cost is that `EPERM` from the create no longer fails fast anywhere: an acquirer pointed at an unwritable lock directory now spins to `timeoutMs` (60s default) before the timeout error — the same bound every other persistent contention already has, and a diagnosable message instead of a raw errno. `EPERM` from the payload write or close keeps failing fast with the original error, exactly as before this change.
