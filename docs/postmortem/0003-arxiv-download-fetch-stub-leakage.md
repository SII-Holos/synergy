# Postmortem: Leaked module-level fetch stub failed the arXiv suite on CI

Status: implemented

## Executive summary

From 2026-08-22, every dev-branch CI Test job failed all 12 `arXiv PDF download` cases with `HTTP 404`, while the suite passed locally and in the Coverage job. The root cause: `test/script/script-identity.test.ts` replaces `globalThis.fetch` at module level with a stub answering every request with 404 and never restores it, and Bun runs each test shard in one shared process — so sibling files fetching their own local test servers got every request answered by the leaked stub. A merge that added two unrelated test files shifted shard boundaries and put the leaking file next to the victim. The first fix attempt misdiagnosed proxied CI runners and shipped without moving the failure signature. The durable lesson: when a suite passes in isolation but fails on CI, co-run the suspects in one process before theorizing about the environment.

## Summary

`packages/synergy/test/script/script-identity.test.ts` pins the environment before importing its subject, and pins the network path the same way: at module scope it installs `globalThis.fetch = stub` where the stub answers every request with `new Response(null, { status: 404 })`. The file's own per-test `finally` blocks restore `globalThis.fetch` from a local read taken _after_ the stub was installed — restoring the stub, not the real fetch. Nothing ever reinstated the real fetch.

`test:ci` runs four shards, each a single shared Bun process. `test/tool/arxiv-download.test.ts` starts a local `Bun.serve` server and fetches it; when both files share a shard and the stub file runs first, every download call gets the stub's 404 (`ArxivDownloadHttpError: Failed to download paper: HTTP 404`). The suite passed in the Coverage job only because `arxiv-download.test.ts` is on the `ISOLATED_COVERAGE_FILES` single-file batch list, and passed in local isolation because a lone process never imports the leaking file.

## Timeline

- 2026-08-17 — `bbd704d79` (refactor: fold support script package) adds `test/script/script-identity.test.ts` with the unrestored module-level fetch stub. Green at the time: shard composition kept it away from local-server suites.
- 2026-08-22 04:14 (UTC) — PR #1248 merges into dev, adding `test/observability/diagnostics.test.ts` and `test/storage/storage-retry.test.ts`. Shard assignment hashes file paths, so the additions shift boundaries: `script-identity.test.ts` and `arxiv-download.test.ts` now share shard 1. Every later dev Test job fails the same 12 cases.
- 2026-08-22..26 — Failures reproduced on unrelated PRs; the signature is stable and environment-shaped (404 on loopback fetches), inviting network-path theories.
- 2026-08-26 — PR #1259's second commit neutralizes proxy env vars in test isolation, diagnosing proxied CI runners (Bun reads `HTTP(S)_PROXY` per request with no loopback bypass). The Test signature does not change. The pinned `NO_PROXY` additionally breaks `test/provider/proxy.test.ts` on the Coverage job: in Bun 1.3.14, a pre-first-fetch `NO_PROXY` overrides the explicit per-request `proxy` option that suite verifies.
- 2026-08-27 — Review of #1259 co-runs the two suspect files on a proxy-free machine and reproduces the exact 12 failures (`bun test test/script/script-identity.test.ts test/tool/arxiv-download.test.ts`); the proxy commit is reverted on #1259 and the restore fix lands in #1263 (18/18 green co-run; CI Test and Coverage green).

## Root cause

A module-level replacement of a process global was never restored, and Bun shards share one process per shard, so the replacement leaked into sibling files. The victim was unrelated to the leak source, and the trigger was an unrelated merge shifting shard boundaries — the same mechanism as [postmortem 0002](./0002-tool-scheduler-singleton-leakage.md), second occurrence.

Why every safety net missed it:

- Local runs did not reproduce: a standalone process never imports the leaking file, and macOS shard composition differs from Linux CI (path hashing).
- The Coverage job did not reproduce: `arxiv-download.test.ts` runs in a single-file isolated batch there. The Test/Coverage asymmetry itself was misread as "environment-dependent" rather than "shared-process dependent".
- `test:ci` stops at the first failing shard, so a poisoned shard masks whatever runs later — the proxy suite regression introduced by the wrong fix was invisible to the Test job and surfaced only in Coverage.
- The 404-on-loopback signature anchored the investigation on the network path. Nobody verified the proxied-runner premise (the workflow sets no proxy variables; hosted runners do not either) before shipping a fix, and the fix shipped without the failure signature moving.
- The per-test `finally` blocks in the leaking file looked like cleanup but restored the stub to itself — a restore written after the replacement is not a restore.

## Guardrails added

- `test/script/script-identity.test.ts` captures the real fetch before installing the stub and restores it in `afterAll` (PR #1263).
- The `testing-guide` skill now states the rule: a module-level replacement of a process global must capture the original before installing and restore it in `afterAll`, because a per-test `finally` that re-reads the global restores the replacement (PR #1263).
- Decision record [Restore Module-Level Fetch Stubs After the Owning File's Tests](../decisions/implemented/testing/2026-08-27-restore-module-level-fetch-stubs.md) captures the cleanup strategy and rejected alternatives.
- This postmortem records the incident narrative, the shard-boundary recurrence, and the misdiagnosis lesson.

## Lessons

- Second occurrence of the 0002 class: any test-file addition can silently move a leak source next to a victim by shifting shard hashes. A test that replaces a process global must restore the original in a cleanup hook — this is now a written skill rule, not tribal knowledge.
- "Passes in isolation, fails on CI" is the fingerprint of shared-process state pollution. Co-running the suspect files in one local process is a minutes-long decisive experiment; environment theories cost days.
- A fix that does not change the failure signature disproves its own diagnosis. Ship a CI fix only with the signature actually moved, and treat "unaffected by the change" test suites as claims to verify, not assume.
