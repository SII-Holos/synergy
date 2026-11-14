# Decision Record: Invalidate destination message ordering after transfer

Status: implemented

## Problem

A Session returning to a previous native Home can replace its canonical messages while retaining that Home's earlier message-order index. The old index can have internally consistent markers and counts, so an ordinary history read omits messages accepted on the other machine even though their bodies are present locally.

## Decision

Core publication invalidates the destination Session's message ordering through `MessageV2.removeOrderIndex` inside its original activation transaction. The existing owner removes the durable ordering index and its in-memory cache. A later read rebuilds ordering from the newly published canonical messages.

Native order memoization is scoped to the original live Store write transaction and exact Scope/Session tuple. Its first access validates current state and marker coverage; the existing mutation guard invalidates affected entries before typed mutations. An overlapping order operation disables memoization for that owner until transaction completion, preserving the original scan and repair behavior. Other owners remain independent. The owner keeps no global order cache or after-commit order publisher. Cold reconstruction keeps its existing unready-state publication and old-index removal before bounded marker-only bulk writes. A repeated marker flushes the preceding window before that key is written again; no marker is discarded and legacy identities do not gain a new bulk uniqueness rejection. Final readiness and transaction-local memo publication remain after successful marker completion.

The change preserves the imported Session identity, message and Part bodies, actors, paused state and transfer Epoch. It does not modify the model working-set policy or introduce another cache. Display records remain inside the transported Session aggregate; their timeline, page and detail reads are verified separately.

## Alternatives considered

**Invalidate only the model working-set cache.** Rejected because ordinary history reads use the separate message-order owner.

**Transport or edit the previous machine's ordering markers.** Rejected because ordering is a local derived index and must describe the actual destination records.

**Clear every Session cache and index.** Rejected because the observed defect concerns the external ordering index. The imported Display records already contain the current messages.

**Keep a global order cache populated after every write.** Rejected because all order loaders already run inside write transactions, so the global cache had no reachable consumer while retaining repeated whole-history arrays.

**Reuse order after overlapping writes.** Rejected because a delayed operation can populate an earlier order after another mutation. A public-write regression retained every canonical header but omitted a message from the same-transaction stream.

## Consequences

A returning Session exposes messages accepted on either machine without reopening execution. Ordering removal participates in activation rollback, and reconstruction uses the current canonical records. Cloud Environment selection, native download, other destination mappings and independent model continuation remain separate capabilities.

Sequential writes in one transaction reuse verified order without repeated full marker scans. Every new transaction and readonly snapshot establishes its own view. Sequential appends reuse the verified marker array and ID mapping rather than copying, sorting and rebuilding all earlier entries after every message. Earlier insertions use the original comparator; reordering and removal still move affected array entries. Initial validation and metadata remain proportional to history, and contended owners retain the original scan/repair path. See [native write amplification](../../../postmortem/0197-native-message-order-repeated-full-history-work.md).

## Verification

The real three-party HTTPS/WSS fixture transfers a private native copy between two enrolled Member Homes and back. It warms the original Home's history before departure, accepts and materializes another context input on the destination, then completes the second surrender, service commit and paused activation. The diagnostic shows two canonical messages at the returning Home while its old ordering contains one. Regression checks cover ordinary and paged history, actor and Part identity, current changed/untracked/ignored files, new private destinations and preservation of both original directories. See [the postmortem](../../../postmortem/0175-returned-session-retained-an-old-message-order.md).
