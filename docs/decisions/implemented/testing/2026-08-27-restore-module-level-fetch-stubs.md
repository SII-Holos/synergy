# Decision Record: Restore module-level fetch stubs after the owning file's tests

Status: implemented

## Problem

Since 2026-08-22 the dev CI Test job failed every `arxiv-download.test.ts` case (12/12) with `HTTP 404`, while the same suite passed in the Coverage job and in local isolation. The first diagnosis blamed proxied CI runners: Bun 1.3.x reads `HTTP(S)_PROXY` per request with no built-in loopback bypass, so PR #1259's second commit deleted the proxy variables and pinned `NO_PROXY` in both test-isolation paths. It did not change the Test job failure signature at all.

The actual cause was shared-process state, not the network path. `test/script/script-identity.test.ts` replaces `globalThis.fetch` at module level with a stub answering every request with 404, and never restored it — the per-test `finally` blocks restore to `globalThis.fetch` as read _after_ the stub was installed, i.e. to the stub itself. `test:ci` runs four shared-process shards, and this file shares shard processes with suites that fetch their own local `Bun.serve` test servers; every such fetch was answered by the leaked stub. The suite passed in Coverage only because `arxiv-download.test.ts` is on the `ISOLATED_COVERAGE_FILES` single-file batch list, and passed in isolation because a lone process never imports the leaking file.

## Decision

Restore the real `globalThis.fetch` from the leaking test file itself: capture it before the module-level stub is installed and reinstate it in `afterAll`, so sibling files in the same shard process keep their real network path. Codify the rule in the `testing-guide` skill: any module-level replacement of a process global (fetch in particular) must capture the original before installing and restore it in a cleanup hook, because the replacement is visible to every sibling file in the same shard process.

## Alternatives considered

- **Neutralize proxy environment variables in test isolation** (PR #1259, reverted): rejected on evidence — the identical failure signature reproduces locally with no proxy variables set anywhere (`bun test test/script/script-identity.test.ts test/tool/arxiv-download.test.ts` fails 12 cases on a clean machine), and the change deterministically broke `test/provider/proxy.test.ts`, because Bun 1.3.14 lets a pinned `NO_PROXY` override the explicit per-request `proxy` option that this suite exists to verify.
- **Add fetch-stubbing files to a shard-isolation list mirroring `ISOLATED_COVERAGE_FILES`**: rejected as the first move — it hides the leak, costs a dedicated process per stubbing file, and the list must grow every time a new test stubs fetch. Restoring at the source is one cleanup hook.
- **Forbid module-level fetch stubs entirely**: rejected — `script-identity.test.ts` legitimately needs fetch pinned before its top-level `await import` runs; the pattern is sound when the stub is restored.

## Consequences

The arXiv download suite passes inside shared shard processes again, and any future suite that fetches a local test server is safe from this class of leak regardless of shard composition. The cost is one captured reference and one `afterAll` per module-level stub, plus the skill rule that keeps new files honest. Diagnosis of shared-process leaks remains nontrivial: `test:ci` stops at the first failing shard, so a poisoned shard can mask later shards — co-running the suspect files in one local process remains the fastest reproduction when a suite passes in isolation but fails on CI.
