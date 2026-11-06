# Historical preparation blocked its own evidence writes

## Executive summary

PR 1467 added a fence around unpublished history but applied it to an internal binary-evidence lookup as well. A completed historical tool with retained output could therefore prevent its own import, including imports required for startup recovery. The released-ledger test contained only text, and retry-status coverage missed an active attempt with a persisted earlier error. Verification must combine admission, evidence conversion and real retry state.

## Summary

A user report that the application would not open prompted review. Isolated fixtures reproduced failed historical tool preparation and a separate stale failure response during retries. These reproductions establish code defects; no affected user's data or logs were available to prove that their reported failure had this exact cause.

## Timeline

- 2026-09-21: PR 1467 merged with passing checks.
- 2026-09-21: Review reproduced the evidence-write failure and stale preparation status using temporary storage.
- 2026-09-21: Focused regressions and released-ledger startup/restart cases were added with the fixes.

## Root cause

The binary writer checked for existing content through a raw store snapshot that always restricted access to published owners. The surrounding migration scope therefore could not write the tool evidence needed before publication. Both on-demand import and recovery-required startup traversed this path.

Preparation status also checked the persisted error before checking active work. A background retry retained the last failure while running, causing the Web controller to treat that response as terminal. An integrity-category error additionally kept the component in its repair state, so changing only the status label would not suffice.

The original released-ledger fixture exercised activation and a text transcript, without a completed tool whose output needed binary conversion. Existing migration tests and admission tests exercised the two mechanisms separately. Retry tests did not hold a new attempt in progress while inspecting its prior failure.

## Guardrails added

- [Admission tests](../../packages/harness/test/storage/compat-admission.test.ts) allow migration evidence writes while rejecting ordinary reads and writes before publication.
- [Preparation tests](../../packages/harness/test/storage/compat-preparation.test.ts) use a real SQLite writer to hold retries in progress for both error categories.
- [Released upgrade tests](../../packages/presets/test/storage/released-history-evidence.test.ts) cover tool output on demand and during startup recovery, then reopen the process and verify exact evidence bytes without duplication.
- [Persistence workflow](../../.synergy/skill/change-persistence/SKILL.md#historical-preparation-verification) requires these combined cases; the [decision record](../decisions/implemented/bug-fix/2026-09-21-historical-preparation-access-and-status.md) records the chosen repair.

## Lessons

Access restrictions need tests for the privileged operation that makes ordinary access safe. Migration fixtures must include payloads that exercise dependent transformations, and retry status must describe the active attempt without hiding a settled failure.
