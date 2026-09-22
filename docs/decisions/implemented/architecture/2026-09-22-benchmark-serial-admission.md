# Decision Record: Serial benchmark evidence admission

Status: implemented

## Problem

A final report can expose invalid evidence after an entire paid schedule has already executed. Aggregate token equality also hides swapped request usage or ambiguous identical request bodies. A preflight tool result alone cannot establish that subsequent trials retain valid grading and accounting.

## Decision

The explicit `strict-synergy-v1` policy accepts only a version 2 Synergy matrix with concurrency one. The [runner](../../../../benchmark/src/synergy_bench/runner.py) and [doctor](../../../../benchmark/src/synergy_bench/maintenance.py) persist native evidence and scheduler state before applying [admission](../../../../benchmark/src/synergy_bench/admission.py). Each next dispatch depends on the preceding admission. Recovery rechecks retained attempts and cannot turn a paid failure into an automatic retry. The existing bounded startup exception still requires positive proof of zero requests, a complete archive and clean teardown.

Admission verifies retained hashes, archive readability, completed grading with positive test-start evidence, and a native reward. Zero reward and expiry of the fixed solving budget remain observations; they do not stop the schedule when grading and evidence are valid. Operator cancellation and infrastructure failures stop new dispatches. Independent admission receipts do not rewrite attempt results or original coverage.

Native Synergy rollout manifests and historical transport archives supply per-request evidence. Response identities disambiguate identical bodies; each association still requires matching bodies and completed input, output, total and cache-read usage. Interrupted usage stays unknown. An unmatched cancelled native record is admitted only when its archive proves an empty partial request, no response and no SDK usage. Such a record remains an unconfirmed dispatch with unknown cost, preserving partial original coverage and preventing an exact-total claim.

The policy is part of pairing conditions. Historical policy omissions remain omissions, rather than inheriting a current default. The public source formats remain the [Synergy rollout archive](../../../../packages/harness/src/session/rollout/archive.ts) and the evaluator's retained transport ledger; no new product execution loop is introduced.

## Alternatives considered

**Gate only after all trials complete.** This can spend the remaining budget on an environment whose grading or evidence has already failed.

**Stop on every zero reward.** This conditions the sample on observed quality and prevents a complete prospective comparison. Native reward and infrastructure admission answer different questions.

**Require exact aggregate usage for every attempt.** Correctly recorded cancellations may have unknowable provider costs. Preserving that uncertainty and checking every completed request yields useful lower bounds without inventing zero usage.

## Consequences

Strict experiments may stop before their planned sample size when evidence becomes invalid. Continuation requires resolving the failure under an explicit new experiment decision, while retaining prior costs and results. Reading complete archives adds local validation work after each execution; the original solving and verifier deadlines are unchanged. The default policy remains available for general failure inventories and other harnesses.

The [local-24 stopped-study audit](../../../research/context-efficiency/2026-09-22-local24-v7-stopped-study.md) records real-provider validation of the cleanup rejection and subsequent dispatch stop. Eventual container removal does not erase a retained cleanup failure, and completed tool checks do not supply missing formal task results.
