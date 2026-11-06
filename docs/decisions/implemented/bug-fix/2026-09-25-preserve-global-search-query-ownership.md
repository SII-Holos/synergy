# Decision Record: Preserve global search query ownership

Status: implemented

## Problem

Global search could publish a stale response after a newer query, render failures as empty successful results, and expose only the first fifty matches. Its custom overlay did not contain focus or return it reliably.

## Decision

Search owns a generation and AbortController per request. Input changes invalidate replies before the debounce expires; disposal aborts pending work. Initial failures retain the query for explicit retry. Pagination maintains its raw server offset, preserves loaded matches after failure, deduplicates overlapping result identities, and rejects pages belonging to a replaced query.

The generated session search client preserves API error semantics and cancellation. Presentation uses the shared Dialog stack, a named input/listbox relationship, and explicit loading, failure, count and load-more states. Escape closes directly and restores the entry focus.

## Alternatives considered

**Only cancel fetch.** A transport can resolve after cancellation; the generation check also protects the debounce interval and disposed views.

**Clear failed results or increase the fixed limit.** Clearing loses useful evidence and a larger cap still cannot represent all matches. Explicit pagination keeps request size bounded and recovery local.

## Consequences

Search remains a manual query surface with bounded pages. Browser tests cover modal focus, query replacement, result selection and pagination recovery; controller tests exercise cancellation, overlapping pages and disposal.
