# Decision Record: Long-term review hydrates original messages incrementally

Status: implemented

## Problem

A long-term review can cover originals outside the model working set. Hydrating every pending message and preparing every model group before the first request makes transient residency proportional to the entire original transcript, despite bounded provider requests.

## Decision

Capture retains canonical source headers, membership and revision proofs. Review hydrates original Parts one source message at a time and fills only the next request's groups. The canonical history owner supplies both bulk export and individual original-message reads. Source proof validation and atomic publication of the final summary and reviewed cursor remain unchanged.

## Alternatives considered

**Hydrate the complete source before splitting model requests.** Rejected because provider token limits do not bound preparatory transcript memory.

**Publish progress after every segment.** Rejected because an interrupted or invalidated review must not expose a partially rewritten long-term summary.

## Consequences

The retained body working set follows request preparation instead of the whole pending transcript. A single oversized original message can still require its complete Part bodies; this change does not establish a strict byte ceiling for an individual source. A multi-segment regression verifies the first model request begins before later original bodies are hydrated. The [Session long-term summary reference](../../../architecture/session-and-messages.md#session-long-term-summary) owns source eligibility and publication semantics.
