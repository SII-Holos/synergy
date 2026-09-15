# Decision Record: Preserve native verification after agent timeout

Status: implemented

## Problem

The benchmark lifecycle wrapper and Pier both enforce the agent deadline. When the outer deadline expires first, Python raises `TimeoutError`. Pier continues to collect artifacts and grade after `AgentTimeoutError` or a native nonzero exit, but treats the generic exception as a trial failure that bypasses verification. Equal deadlines therefore make grading depend on event-loop scheduling.

## Decision

[BenchmarkTrial](../../../../benchmark/src/synergy_bench/trial.py) translates the outer agent deadline into Pier's `AgentTimeoutError` while retaining its cause and original deadline. The lifecycle record marks native timeout exceptions as timed out. Verifier, export and cleanup deadlines remain independent. A [real Docker regression](../../../../benchmark/test/test_oracle.py) executes a native oracle with a short deadline and requires the native verifier to finish with its original reward.

## Alternatives considered

Increasing one deadline would reduce the race without preserving the exception semantics under other interruptions. Re-running verification during report import would mutate historical evidence and mix evaluator versions. Neither provides a reliable lifecycle boundary.

## Consequences

Agent timeouts remain recorded failures and still receive native grading. Existing records remain unchanged; validation with the corrected evaluator creates a separate experiment with an explicit reason. This extension depends on the pinned Pier exception contract and must be checked when upgrading Pier. Docker exec without an explicit timeout must inherit the native caller deadline; a preparation default at a lower layer can otherwise fire early while the exception reports the longer outer limit. The [deadline regression](../../../../benchmark/test/test_environment.py) covers both missing and explicit execution deadlines.
