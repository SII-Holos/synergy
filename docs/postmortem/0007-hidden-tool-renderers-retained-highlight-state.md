# Hidden tool renderers retained highlight state

## Executive summary

A collapsed tool card evaluated its JSX children to decide whether it had details. Solid child getters constructed imperative renderers during those checks, so closed cards performed work and retained subscriptions. Existing tests checked titles and visible output but did not count renderer lifetimes. Behavioral lifecycle tests and capacity budgets address this class of defect.

## Summary

Code-heavy sessions showed increasing rendering cost and renderer crashes. Source tracing found three independently reproducible defects: hidden detail construction, string admission queues retaining promoted entries, and a legacy multi-edit renderer calling a keyed diff value as a function. These findings do not establish the cause of every reported crash or the identity of an original minified exception without its stack.

## Timeline

On September 7, 2026, source analysis and isolated component experiments reproduced two renderer constructions while a tool remained closed, a third on expansion, and cleanup of only the visible instance on collapse. A repeated-distinct-string experiment demonstrated unbounded admission-queue retention. A real Solid multi-edit fixture subsequently reproduced the object-as-function error.

## Root cause

Reading `props.children` is execution, not passive presence detection. The predicate reads constructed renderers under owners that outlived the visible disclosure. The worker pool's subscription collection retained those renderers until owner cleanup; this was avoidable retention during the parent's lifetime, rather than proof of retention after parent disposal.

String admission used separate maps and order arrays. Promotion deleted the map entry without deleting its order-array reference, and eviction depended on map size. Typechecking also missed the keyed multi-edit error because metadata was loosely typed. Mocked render tests never executed the callback.

## Guardrails added

The [lifecycle regression](../../packages/ui/test/components/basic-tool-lifecycle.dom.test.ts) uses real Solid and disclosure components to check closed/open/closed counts and keyed multi-edit rendering. [String capacity tests](../../packages/app/test/context/string-interner-budget.test.ts) exercise repeated promotions. [Highlight budget tests](../../packages/ui/test/pierre/cache-budget.test.ts) verify shared eviction and the installed dependency's injected cache. The [decision record](../decisions/implemented/bug-fix/2026-09-07-bound-tool-rendering-memory.md) records preview and cache tradeoffs, and the [frontend Skill](../../.synergy/skill/develop-frontend/SKILL.md) requires demand-driven renderer lifetime checks.

## Lessons

Visible DOM alone does not account for retained imperative renderers. Test construction and disposal across disclosure transitions, bound auxiliary admission structures alongside their primary caches, and execute real framework callbacks when validating reactive control flow.
