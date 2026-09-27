# Decision Record: Separate session listing capacity fixtures

Status: implemented

## Problem

The Session record regression performs five full listings of 1,300 sessions across 1,151 distinct Workspaces, two index rebuilds and a binding update inside one 30-second test. A Linux coverage batch exhausted that deadline and the test runner terminated its two SQLite workers. The failure does not identify a storage deadlock: isolated phase measurements completed both setup and shutdown, with most time spent advancing the public listing operations. Those measurements did not reproduce the precise CI stopping point.

## Decision

Parent listings and child listings run as independent tests, each with a fresh Runtime and the same 1,300-session, 1,151-Workspace dataset above the 1,024-operation admission capacity. A shared fixture retains the real storage transaction and index rebuild. Both tests keep the 30-second deadline.

The parent test covers full enumeration, ordinary listing, title search and every Session's Workspace projection, followed by a real Workspace rebind and fresh projection assertion. The child test retains the parent assignment transaction, index rebuild, full child enumeration and child page assertions. All five public listing calls and the existing assertions remain covered. Production reads that refresh Session and Workspace state are unchanged.

## Alternatives considered

**Raise the combined deadline or reduce the dataset.** Rejected because the former obscures which independent operation fails and the latter can stop exercising admission pressure.

**Remove repeated production hydration.** Rejected because those reads carry freshness semantics, and the timeout alone does not establish that they can be omitted safely.

## Consequences

The suite constructs an additional isolated dataset and Runtime. Each failure identifies the affected listing family without charging unrelated complete listings to its deadline. This is a change to correctness-test granularity, not a storage performance claim or proof that the original CI timeout was a product deadlock.
