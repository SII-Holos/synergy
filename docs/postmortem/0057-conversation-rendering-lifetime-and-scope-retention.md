# Conversation rendering lifetime and Scope retention

## Executive summary

Session navigation reused transcript-local presentation owners, reconnect removed accepted content before replacement, virtualizer cleanup lost measured layout, and Scope eviction left content-budget callbacks retaining released stores. Short static fixtures did not exercise overlapping owner disposal, historical Part ranges, delayed measurements or garbage-collection reachability. The durable rule is to give each transcript one immutable resource identity, revalidate accepted content in place and release every reference owned by an evicted Scope.

## Summary

The reported symptoms were mixed message/tool mounting, unstable scrolling, flashing recovery and memory growth after long background intervals or Session switches. Auditing open rendering PRs and adjacent sync, layout and Markdown owners showed several independent mechanisms. Each required a regression at its owning behavior rather than another delay or remount fallback.

## Timeline

- Read-only inspection located the primary Runtime and existing large Session; development used a separate worktree, Home and ports.
- Failing regressions reproduced a retained old transcript, writes after Sync disposal, missed process following after body measurement, destructive reconnect content invalidation and content bytes retained after Scope eviction.
- A Chromium heap snapshot traced released payloads through the content budget's eviction callback into the old Scope store.
- The large Session was exported privately and imported through the canonical API into the isolated Runtime for whole-page acceptance; raw history and heap snapshots remain outside the repository.

## Root cause

The native plugin page outlet retains its route owner, so resetting an admission signal did not dispose the transcript's virtual rows or pending layout state. Session metadata and diff requests could finish after their Sync owner had gone away. Reconnect cleared accepted bodies and Part-page state; reloading the default page could discard previously loaded target or history intervals. Process resize delivery followed only an explicitly clicked latest action, leaving ordinary active following behind after lazy hydration. Virtualizer cleanup attempted to read a handle after its ref had already been cleared. Prepended rows left measurements at their old indices while the page and list each scheduled DOM anchor correction. Internal Part backfill could unmount the reading row before its viewport owner restored it. Inner virtualizer child churn was mistaken for real body layout; even with that classifier corrected, native input arriving during real body growth could lose its new reading anchor to older layout restoration. Finally, evicted Scope payloads remained reachable through content-budget callbacks even after the Scope registry no longer contained them.

## Guardrails added

The [rendering lifetime decision](../decisions/implemented/architecture/2026-10-07-conversation-rendering-lifetime.md) defines transcript ownership, retained range recovery, plain bounded layout caching and exact Scope cleanup. Behavioral regressions cover owner changes and late replies, retained body identity during recovery, large and disjoint Part windows, following and reading under delayed measurement, width-sensitive cache reuse, pure prepend and internal backfill, simultaneous native input and body growth, and provider disposal. The browser memory regression compares full-GC reachability with the allowed eight inactive Scope stores and verifies disposal releases all payloads.

Production-build acceptance used an existing Session with 554 messages and 2,991 Parts in an isolated Runtime. Cold loading, switching to an empty Session and returning, historical loading and bounded tool-process reading showed unique mounted row identities and released the previous transcript. Narrow layout and reduced motion were checked separately. These whole-page observations complement deterministic reconnect and native-input regressions; they do not substitute for their controlled ownership assertions.

## Lessons

Count and byte ceilings do not prove an evicted owner is unreachable. The baseline retained 16 payload markers after a 16-Scope churn; the fixed implementation retained the permitted eight after each of three 16-Scope batches and zero after provider disposal. DOM and listener counts remained constant. Heap size is supporting diagnostic evidence; the retained-object invariant determines acceptance. A stable visible window is accepted data plus a reading owner, and reconnect freshness must not destroy either before replacement is ready.
