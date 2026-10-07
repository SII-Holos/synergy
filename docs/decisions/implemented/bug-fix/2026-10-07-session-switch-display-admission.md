# Decision Record: Stable conversation admission during Session switches

Status: implemented

## Problem

Switching to a cached Session can hide its transcript for repeated storage preparation, rebuild it from headers before lazy bodies arrive, and expose the initial scroll before it reaches the latest content. Background prefetch populated full Parts while the renderer consumed summary pages and versioned body leases. Plugin page loads also replaced a temporary native fallback on each Session change. Stable message identities cannot preserve a tree that these admission steps replace. See the [incident analysis](../../../postmortem/0051-session-switch-repeated-display-admission.md).

## Decision

The global SDK owns a bounded, server-keyed cache of ready storage preparations, cleared when the connection is lost. Foreground initial loads and navigation prefetch use the same bounded timeline, summary-page and versioned-body preparation. They warm the latest root and three tail messages, at most sixteen renderable text or attachment bodies and 128 KiB of declared content. Existing resource watermarks and Part snapshot freshness checks admit the result atomically into the shared Scope store and content budget. Oversized bodies and unsuccessful reads retain the existing lazy loading and retry path.

The native conversation keeps its viewport mounted but hidden and inert until mounted body leases settle and connected Scope recovery and the initial latest or hash scroll complete. Two animation frames allow the resulting layout and scroll to commit. Errors count as settled content and remain actionable. Admission latches for that Session, so streaming updates and retries preserve visible rows. A captured first submission retains its existing viewport through canonical handoff. The shared latest-following hook commits its bottom pin during content resize delivery, keeping delayed renderer layout from painting one frame before correction; manual reading retains the existing anchor path.

A Shell surface reuses its successfully loaded component only while its entry and loader identities match. Each Session still owns a fresh presentation lifetime and bound services; stale loads cannot populate the component cache.

## Alternatives considered

**Only retain message identities.** Identity reconciliation remains necessary, but it cannot prevent storage admission from hiding the conversation or prevent an asynchronous fallback from replacing it.

**Preload every body.** This would remove lazy content admission at the cost of unbounded network, memory and initial latency on long conversations. Bounded warming and mounted leases preserve virtualization.

**Retain plugin services across Session switches.** This would avoid remounts but allow commands and late requests to act on a successor Session. Component reuse leaves the existing service disposal intact.

## Consequences

Cached navigation avoids repeated preparation and renderer protocol mismatch. Cold navigation may show one loading state while its bounded viewport and initial position settle; it does not present intermediate transcript positions. Preparation reuse is deliberately limited to the connected runtime, and lazy offscreen content remains lazy. Regression coverage includes cache isolation, bounded content and freshness, shared-budget eviction, delayed bodies, streaming visibility and plugin service release. The current invariants live in [Frontend data sync](../../../architecture/frontend-data-sync.md) and [Frontend Plugin Platform](../../../architecture/frontend-plugin-platform.md).
