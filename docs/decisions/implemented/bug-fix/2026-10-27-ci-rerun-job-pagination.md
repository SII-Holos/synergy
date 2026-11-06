# Decision Record: Complete CI rerun evidence with smaller job pages

Status: implemented

## Problem

CI input reuse and final admission inspect every workflow attempt to distinguish actual executions from copied sibling jobs. A large rerun history can fail at GitHub's maximum job page size before any selected test executes. A live comparison against the same 132-record history returned HTTP 502 with 100 jobs per page and succeeded with 50. Repeating the unchanged maximum-sized request does not establish missing provenance.

## Decision

The shared job reader in `script/ci/github.ts` requests 50 records per page and continues until a page contains fewer than that same page size. Input producer selection and final admission consume the complete history through this reader. Existing rejection of failed producers, expired artifacts and latest failed executions remains unchanged; copied sibling jobs still cannot supply a newer execution.

## Alternatives considered

**Retry maximum-sized pages.** Consecutive workflow attempts and a direct request reproduce the same 502. Retrying that response size alone leaves input preparation unable to reach the tests.

**Read only the latest attempt or stop after one smaller page.** This loses successful input producers retained from older attempts and can hide a newer actual failure behind copied success records. Missing history cannot authorize reuse or admission.

**Require a fresh workflow for every retry.** This discards reusable successful execution evidence and repeats expensive builds and tests without repairing partial rerun support.

## Consequences

Large histories require more requests, but each response is smaller and no job records are discarded. Other HTTP failures remain explicit errors rather than becoming empty evidence or successful admission. The smaller page size does not claim to eliminate every upstream 5xx failure.

The regression in `test/script/ci-github.test.ts` rejects maximum-sized requests and places the latest actual failure after 130 copied success records. It requires all three smaller pages and preserves the failure, protecting both response sizing and complete traversal. Released-upgrade assertions and native lifecycle timeouts are not changed.
