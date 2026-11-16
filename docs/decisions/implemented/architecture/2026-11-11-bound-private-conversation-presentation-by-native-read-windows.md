# Decision Record: Bound private conversation presentation by native read windows

Status: implemented

## Problem

An organization conversation must display a creator's actual private history without hydrating the complete native transcript or exposing Runtime credentials. Shared blob identities and replay sequence numbers do not exist for private fields, while historical summaries cannot substitute for their original text and tool results.

## Decision

The organization client consumes the [bounded native read protocol](2026-11-11-read-private-sessions-through-bounded-native-contracts.md) through one typed reader. Desktop selects its captured supervised driver when available; other reads use the generated transient organization operation. A native conflict does not silently switch transports. Every response must match the captured Session binding, source and query, and cancellation revokes its exact IPC request. Native authorization failures suspend only the captured current space.

Keep recent message windows, independent per-message part pages and a virtualized reading surface. Release offscreen part bodies and canonical rendered Parts together. Read headers retain real metadata; small fields load through the shared incremental checksum consumer, while larger fields require an explicit action. Individual in-memory fields remain bounded, decoded content has a normal residency budget and a hard protected-content limit, and current focused or selected rows retain their reading state. Preparation stays distinct from readable content.

Reuse the ordinary message renderer and the same safe message/part projectors used for shared conversations. Native references remain native references. Missing model, accounting and timing fields remain unavailable; retained partial original output stays partial. Private titles and current control observations arrive through authorized reads and do not become organization directory metadata.

## Alternatives considered

**Hydrate native objects through a general Desktop fetch proxy.** Such a proxy would expose unrelated native metadata and make memory scale with complete retained fields.

**Convert private references into synthetic shared blobs or replay events.** These identities would imply persistence and synchronization guarantees the private Runtime does not provide.

**Use summaries as the conversation body.** A summary loses actual dialogue and tool results and cannot support ordinary reading or integrity checks.

## Consequences

The transport regression verifies local-driver selection, generated remote requests, binding rejection, exact cancellation, bounded active reads and absence of conflict fallback. The rendered regression reads real UTF-8 field bytes with checksums through the ordinary message renderer and clears retained private content when native authorization is revoked.

The Project conversation route retains the next draft while an earlier submission has an unknown outcome, reconciles that original logical request explicitly and preserves unsaved resource choices across a revision conflict. Command acknowledgements must match the captured account, target and operation before clearing the pending request. Desktop local creation starts the member Runtime only on explicit submission and requires an explicit project-directory binding before proceeding.

The real application-shell browser fixture verifies a readable transcript area and reachable Send, Pause, Cancel and Share controls in both wide themes and narrow, short viewports. Native attachment access, interaction replies, task navigation and handoff retain their own acceptance evidence.
