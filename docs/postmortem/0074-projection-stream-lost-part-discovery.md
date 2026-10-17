# Projection stream lost Part discovery

## Executive summary

Completed replies could remain absent until a full page refresh even though canonical messages and bodies were present. The projection stream rejected obsolete subscription frames before they reached the existing summary discovery logic. Tests exercised the helper and reducer directly, so they missed the transport bypass.

## Summary

A retained message can have an accepted Part page without its later final text. A rejected first checkpoint supplies no row identity, and renewed interests contain only already-known Parts. The completed message header and task status can therefore advance independently of the missing body. Reading a fresh snapshot repairs the presentation. The reported incident's pre-refresh browser state was unavailable; deterministic reproduction establishes this failure path without asserting every reported omission had the same trigger.

## Timeline

- Read-only inspection confirmed that the reported final messages had completed and their full text remained stored.
- Tracing the WebSocket handler found a subscription gate preceding the existing discovery projection.
- A regression through the actual GlobalSDK provider failed when an obsolete first checkpoint produced no event.
- A separate held-reference regression failed when pruning cancelled the read without retaining discovery.
- Routing both discarded paths through summary projection preserved discovery while rejecting their bodies.

## Root cause

Generation checks protect active content from obsolete owners, but existence discovery has different semantics. `createPartProjectionStream` returned before `projectContentSummary` could downgrade rejected content to a discovery hint. Its cancellation path also discarded a first reference summary while aborting the content read. Component-level tests began after that decision and could not observe the loss.

## Guardrails

The [WebSocket regression](../../apps/web/test/context/global-sdk-content.dom.test.ts) mounts the real provider and drives its transport callback across inactive owners, visibility renewal and delayed large references. The [projection-stream regression](../../apps/web/test/context/part-projection-stream.test.ts) checks cancellation and content ordering. Existing [GlobalSync coverage](../../apps/web/test/context/global-sync-part-repair.dom.test.ts) protects loaded-window admission and newer accepted content; [queue coverage](../../apps/web/test/context/event-queue.test.ts) protects authoritative updates from discovery coalescing. The [decision](../decisions/implemented/bug-fix/2026-10-04-preserve-part-discovery-after-subscription-renewal.md) owns the distinction between discovery and content authority.

## Lessons

Recovery helpers need coverage through each transport path that can reject their inputs. Protecting obsolete bodies must not remove the only evidence needed to discover a new Part. Reuse the bounded content loader instead of reloading retained history or weakening generation checks.
