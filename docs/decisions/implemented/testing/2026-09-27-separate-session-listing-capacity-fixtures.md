# Decision Record: Separate session listing capacity fixtures

Status: implemented

## Problem

Session record capacity regressions perform full listings of 1,300 sessions across 1,151 distinct Workspaces. Combining independent listing operations inside one 30-second test can exhaust the deadline in a Linux coverage batch, including when child enumeration and child pagination share a deadline. The test runner then terminates the SQLite workers. Isolated phase measurements complete setup and shutdown, with most time spent advancing public listing operations; the timeout alone does not identify a storage deadlock.

## Decision

Parent listings, child enumeration and child pagination run as independent tests, each with a fresh Runtime and the same 1,300-session, 1,151-Workspace dataset above the 1,024-operation admission capacity. A shared fixture retains the real storage transaction and index rebuild, assigning parent IDs during seeding for child cases. Each test keeps the 30-second deadline.

The parent test covers full enumeration, ordinary listing, title search and every Session's Workspace projection, followed by a real Workspace rebind and fresh projection assertion. Separate child tests cover full child enumeration and child pagination against equally sized fresh datasets. All five public listing calls and the existing assertions remain covered. Production reads that refresh Session and Workspace state are unchanged.

## Alternatives considered

**Raise the combined deadline or reduce the dataset.** Rejected because the former obscures which independent operation fails and the latter can stop exercising admission pressure.

**Remove repeated production hydration.** Rejected because those reads carry freshness semantics, and the timeout alone does not establish that they can be omitted safely.

## Consequences

The suite constructs three isolated capacity datasets and Runtimes. The extra child fixture repeats seeding and cleanup, which phase measurements show cost substantially less than either child query. Each child failure identifies the affected API without charging the other complete listing to its deadline. This changes correctness-test granularity without reducing admission pressure, changing production performance or establishing that a CI timeout was a product deadlock.
