# Decision Record: Restore module-level fetch stubs after the owning file's tests

Status: implemented

## Problem

`test/script/script-identity.test.ts` pins the network path the same way it pins the environment: it replaces `globalThis.fetch` at module level with a stub answering every request with 404, before its top-level `await import` runs. The file's per-test `finally` blocks restore `globalThis.fetch` from a read taken after the stub was installed, so they restore the stub, not the real fetch. Bun runs each `test:ci` shard in one shared process, so an unrestored module-level replacement leaks into every sibling file in the shard — the incident this decision answers is recorded in [postmortem 0003](../../../postmortem/0003-arxiv-download-fetch-stub-leakage.md).

## Decision

The file that replaces a process global owns restoring it: capture the original before installing the replacement and reinstate it in `afterAll`, so sibling files in the same shard process keep the real global. The rule is codified in the `testing-guide` skill: a module-level replacement of a process global (`globalThis.fetch` above all) must capture the original before installing and restore it in a cleanup hook, because a per-test `finally` that re-reads the global restores the replacement, not the original.

## Alternatives considered

**Neutralize proxy environment variables in test isolation.** Rejected: it answered an environment theory, not the leak — the failure signature did not move, and the pinned `NO_PROXY` broke `test/provider/proxy.test.ts` because Bun 1.3.14 lets a pre-first-fetch `NO_PROXY` override the explicit per-request `proxy` option that suite verifies. The full account is in [postmortem 0003](../../../postmortem/0003-arxiv-download-fetch-stub-leakage.md).

**Add fetch-stubbing files to a shard-isolation list mirroring `ISOLATED_COVERAGE_FILES`.** Rejected: it hides the leak, costs a dedicated process per stubbing file, and the list must grow with every new stub. Restoring at the source is one cleanup hook.

**Forbid module-level fetch stubs entirely.** Rejected: `script-identity.test.ts` legitimately needs fetch pinned before its top-level `await import` runs; the pattern is sound when the stub is restored.

## Consequences

Sibling files that fetch local test servers are safe from this leak regardless of shard composition, and the skill rule keeps new module-level replacements honest at review time. The cost is one captured reference and one `afterAll` per module-level stub. Co-running suspect files in one local process remains the fastest reproduction when a suite passes in isolation but fails on CI — `test:ci` stops at the first failing shard, so a poisoned shard masks later shards.
