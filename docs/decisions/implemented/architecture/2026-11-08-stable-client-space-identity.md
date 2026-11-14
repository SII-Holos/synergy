# Decision Record: Stable client space identity

Status: implemented

## Problem

A URL can refer to a different Home after a restart, while one Home can move between URLs. URL-owned caches consequently risk assigning drafts, model choices and layout to the wrong Runtime. A disposed view can also leave shared reads in flight and accidentally reuse them when the user returns.

## Decision

Capabilities expose the existing persisted Harness Host identity. The Web startup owner verifies it before mounting business providers and rechecks it during capability negotiation. Personal cache keys use the Home UUID; organization identity primitives use organization, account and deployment incarnation. URLs remain transport addresses. Personal provider instances own request cancellation, dialogs and a distinct in-flight sharing key; view generation primitives abort a departed view before publishing its successor.

An explicit versioned browser migration claims legacy URL data for its first verified Home. Only the first default personal identity can claim unscoped histories, preferences and historical Scope/layout state; replacing the default connection does not transfer that claim. Copying precedes source removal, existing destination values win, and a pending claim survives failure. A different Home cannot resume that claim. Plugin selections and question, file, Note and composer drafts use the stable owner. Application theme and locale preferences remain independent.

## Alternatives considered

**Continue URL ownership.** This cannot distinguish replaced Homes and loses continuity when an address changes.

**Clear every cache on an identity change.** This removes unsent user work and prevents restoration when returning to the original Home.

**Store a new client-generated Runtime UUID.** A browser-generated identity cannot identify the serving Home. Reusing the existing durable Host identity avoids a second server identity and another upgrade path.

## Consequences

A missing, malformed or unreadable identity prevents business startup; capability negotiation and cache promotion must succeed first. Legacy URL caches carry no proof of their historical Home, so first adoption trusts the configured connection and records that choice permanently. Conflicting old values remain recoverable instead of replacing newer edits. The cache namespace is attribution, not authorization; server authentication and domain revision checks remain authoritative.

Focused tests cover persisted identity across restart, different Homes, malformed storage, URL aliases and replacement, interrupted browser migration, cancellation, stale capability responses, disposed Scope-preparation callbacks, portalled dialog disposal and identity-scoped model restoration. Existing file, decision, Note, workbench and synchronization tests exercise the changed consumers.
