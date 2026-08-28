# Decision Record: fs-lock stale-owner reclamation by process start identity

Status: implemented

## Problem

`withFileLock` reclaims an existing `.lock` file when its recorded owner is provably gone. The liveness probe was `process.kill(pid, 0)` alone. Pids recycle on every platform, and on Windows they recycle aggressively: after a hard-crashed owner leaves a lock behind and its pid is reused by an unrelated live process, the probe reports the dead owner as alive forever. Every later acquirer then spins to its 60s timeout, effectively wedging the credential store, Holos accounts store, and migration-log merges this lock exists to serialize.

The probe answers the wrong question. "Is this pid alive?" is not "is this pid still the process that took the lock?" — a recycled pid makes the two diverge permanently.

## Decision

Stale-owner detection now uses the owner's **process start identity** — the creation time of the process occupying the pid (`/proc/<pid>/stat` start ticks on Linux, wmic/PowerShell `CreationDate` on Windows, `ps -o lstart=` elsewhere), extracted into `packages/util/src/process-identity.ts` and shared with `ServerProcessLock`, which already used this technique for the daemon singleton lock. Lock payloads record `startIdentity` alongside `pid`; an existing lock is stale when its pid is dead **or** the pid is alive but its current start identity no longer matches the recorded one. A live owner is never displaced by age on any platform.

Supporting hardening shipped with the decision, closing gaps the review of the age-based proposal surfaced:

- Release is token-validated: the payload carries a per-acquisition `ownerToken`, and release reads back the file and unlinks only while the token still matches, so a displaced or raced owner cannot unlink a successor's lock.
- Stale reclamation is read-compare-unlink against the snapshot the verdict was based on — never a rename that vacates the canonical path, which lets a delayed rename displace and discard a successor's fresh lock when several waiters observe the same stale payload.
- The acquisition loop checks its timeout at the top of every iteration, so a lock file that keeps failing to unlink can no longer produce an unbounded no-sleep spin.
- Payloads without `startIdentity` (written by older versions) are treated as owned while their pid is live — a transitional fail-safe, not a reclamation trigger.
- Live-owner verdicts are cached only briefly (1s TTL), so an owner that exits and recycles during a long acquisition is re-detected instead of staying classified as live until timeout.

## Alternatives considered

**Wall-clock age eviction (PR #1257)** — reclaim any Windows lock older than `staleMetadataMs` (5s default) regardless of owner liveness. Rejected: it silently redefines that option as a maximum hold time for legitimate owners. All call sites use the default and hold the lock across multiple file operations that Windows AV/indexers can stretch past 5s, so a merely slow owner gets displaced mid-critical-section — trading a loud 60s timeout for a silent mutual-exclusion violation on exactly the stores the lock protects. Wall-clock aging also breaks under clock rollback, which reintroduces the permanent stall.

**Kernel locks (`flock`/`LockFileEx`)** — the kernel releases them automatically when the owning process dies, sidestepping pid identity entirely. Rejected for this fix: Bun 1.3.14 does not expose `flock` portably, and Windows mandatory-lock semantics interact poorly with antivirus and sync clients holding handles (#1247). Not ruled out as a future primitive.

**Lease with `leaseMs ≥ timeoutMs` as the only mechanism** — bounding displacement so no waiter can evict an owner before the waiter itself gives up. Rejected alone: it converts the permanent stall into a one-timeout stall without ever determining whether the owner is actually gone; retained only as a possible future complement for a hung-but-alive owner, which is a liveness problem outside this fix's scope.

## Consequences

Recycling is now detected deterministically on every platform, and posix gains the same protection Windows needed (pids recycle there too, just more slowly). Linux identities include the boot id so start ticks cannot collide across a reboot; Windows normalizes WMIC local-time and PowerShell .NET-ticks to one UTC-epoch encoding so the two query paths stay comparable. The identity query spawns one subprocess per contested lock that looks stale — only on the contested path, cached per acquire loop and shared across concurrent acquisitions, and never on uncontended acquisition or normal release. When an identity cannot be queried (hardened PowerShell, missing `ps`), the owner is treated as live: the lock fails closed, preserving mutual exclusion at the cost o…
