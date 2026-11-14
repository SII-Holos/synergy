# Decision Record: Retain native deallocation claims through final saving

Status: implemented

## Problem

Environment release can publish `releasing` before its resource owner obtains the final Workspace checkpoint or detach claim. A later Runtime maintenance hold refuses that new physical claim. The incomplete release then prevents both freezing and maintenance release. A new deallocation could enter the same state after the hold already existed.

## Decision

New deallocation checks maintenance admission before preparation and again in its canonical release transaction. The transaction revalidates the selected allocation and generation after reservation. Providers may supply `withDeallocation()` to retain their physical resource ownership around the complete operation.

The native provider resolves only its allocation's indexed mounts, requires matching native mount receipts and paths, and enters the existing detached Workspace retirement operation. Its original task and exclusive claims precede release publication and remain held through object saving, detach, native deallocation and idle publication. Native file operations inherit the original parent claim and scoped finalizer; no general admission flag or second physical ledger is added.

The owning catalog independently checks complete index coverage before yielding release mounts in bounded pages. Release preparation blocks new Environment use admission, including its publishing transaction, so a disjoint Workspace cannot appear after the physical roots were selected. Recovery of a retained `releasing` allocation uses the same release owner and native reservations. An already detached view is excluded only through the exact original native detach receipt; an absent ordinary view is not completion evidence.

The Environment owner retains one actual release promise. Its callback checks Runtime, Store, artifact directory and artifact object owner, expires when completion settles and cannot be reused elsewhere. A provider wrapper cannot abandon started work by returning or failing early. The owning release is drained, its canonical result is returned, and distinct wrapper and release failures remain visible together.

## Alternatives considered

**Allow every finalizer during maintenance.** A caller label would authorize unrelated paths and new writers. Existing retirement claims carry actual ownership and native root containment.

**Leave an accepted release blocked until maintenance ends.** Its retained `releasing` state also blocks ending maintenance, so the operations cannot recover each other.

**Use controller retirement for every provider.** Remote physical paths do not prove ownership on the controller. The native provider installs this reservation; other providers retain their own physical mechanisms.

## Consequences

Real native fixtures reject new deallocation without changing the allocation or mount, finish an already accepted detach under a later hold, and save the last object Workspace bytes before returning idle. A second coordinator cannot acquire the held path. A hold after reservation still refuses an unpublished release. Independent Runtime and Store fixtures reject escaped callbacks; early-returning and failing wrappers drain the original operation exactly once.

Additional real counterexamples reject missing index coverage, retain native ownership during release reconciliation, refuse a newly attached disjoint Workspace during preparation, and recover a committed detach with a lost response through its unchanged receipt and generation.

The original allocation, receipt and generation remain authoritative. Failed native saves or termination remain reconciliation blockers. This change does not certify remote writer exclusion, complete external-resource capture, per-Session handoff ownership or deployment recovery. See [the postmortem](../../../postmortem/0105-native-deallocation-crossed-maintenance-hold.md).
