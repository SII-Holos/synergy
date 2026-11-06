# Decision Record: Preserve dynamic schema identity during native JSON Schema traversal

Status: implemented

## Problem

Configuration and Session schemas expose early concrete Zod references whose owners register independently in each Runtime. Zod 4.4.3 processors capture their constructed schema instance, while native traversal registers a transparent Proxy as a different identity. Wrapper processors then fail to find their instance in the traversal context. Resolving a new optional field or enum on each property access also prevents a traversal from observing a stable owner instance. Server-only conversion changes would leave shared configuration and other schema consumers broken.

## Decision

`ConfigExtensions.dynamicSchema` retains its concrete Proxy surface. When the resolved schema exposes the newer processor hook, an adapted internals view calls the native core traversal on that resolved instance in the same context and path, then sets the facade's existing wrapper reference to the resolved instance. Each identity has its own traversal entry. Native traversal owns definitions, reuse, cycles, metadata and finalization. The adapter preserves the original parent and does not mutate resolved internals, alias entries, run an independent conversion or repair JSON output.

Instance JSON Schema methods and Standard Schema input/output converters are rooted at the facade. Standard validation retains the resolved schema's behavior. Ordinary detached methods, derived schemas and already-fetched shapes remain resolved-instance snapshots, not promises of later registration updates. The property-descriptor view exposes the same adapted internals as ordinary access. The older class-based converter, which lacks the new processor hook and method factories, retains its original path.

Field projections cache optional owner schemas in Runtime state by registration generation; metadata copies preserve descriptions and reference names but exclude the owner's registry `id`, since a different projection identity must not claim that identifier. Configuration-domain enumeration caches in its own Runtime state and invalidates when a new domain ID registers. No Runtime-owned schema is installed into global metadata for a shared facade.

The adaptation follows Zod 4.4.3 npm source commit `f3c9ec03ba7a28ae72d25cc295f38674bee0f559`, cited beside the implementation. Upstream explicitly marks `processJSONSchema` as internal, non-public and subject to change. Exported core traversal functions do not make that hook a stable public API. Narrow local structural types allow the same source to compile against the pinned older version without copying the upstream implementation.

## Alternatives considered

**Forward the captured processor or bind its receiver.** The processor closes over its original instance, so changing `this` cannot reconcile traversal identity. A fixed optional instance reproduces the failure independently of fresh allocations.

**Replace the concrete facade with shared `z.lazy`.** Newer Zod caches the inner lazy schema on the shared definition. This freezes early registration and can expose one Runtime's schema to another; it also removes concrete object and enum introspection.

**Hide the processor, manufacture parent links, or alias traversal entries.** Hiding depends on fallback processor tables unavailable to instance conversion. A fabricated parent invokes refinement-specific property removal. Entry aliases conflate counters, cycles, metadata and override identities. Native wrapper references preserve separate identities without these changes.

**Resolve schemas only in Server or patch generated snapshots.** Configuration publishing, Session schemas and nested field projections share the facade owner. A Server workaround duplicates conversion policy and cannot prove reference-consumer correctness.

## Consequences

The facade and resolved instance are observable as separate native traversal nodes: override callbacks and generated definition layouts need not match a single-node conversion. Metadata identifiers cannot be duplicated across those identities. Focused tests compile reused and recursive generated schemas with valid and invalid inputs, retain facade metadata across static and available instance/Standard converters, check concrete reflection and methods, and alternate two simultaneously alive Runtimes. Full composition tests require successful cold `/doc` and API generation in both orders with component preservation.

This is a bounded version-coupled compatibility adaptation, not a blanket guarantee for future Zod internals. Dependency upgrades must rerun those public-behavior regressions and cold OpenAPI generation. Performance and publication remain separate from compatibility: neither this repair nor synthetic schema-bank measurements establish real Runtime memory savings. See the [recursive Agent error initialization decision](2026-10-07-recursive-agent-error-schema-initialization.md).
