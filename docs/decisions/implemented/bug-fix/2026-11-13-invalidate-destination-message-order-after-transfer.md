# Decision Record: Invalidate destination message ordering after transfer

Status: implemented

## Problem

A Session returning to a previous native Home can replace its canonical messages while retaining that Home's earlier message-order index. The old index can have internally consistent markers and counts, so an ordinary history read omits messages accepted on the other machine even though their bodies are present locally.

## Decision

Core publication invalidates the destination Session's message ordering through `MessageV2.removeOrderIndex` inside its original activation transaction. The existing owner removes the durable ordering index and its in-memory cache. A later read rebuilds ordering from the newly published canonical messages.

The change preserves the imported Session identity, message and Part bodies, actors, paused state and transfer Epoch. It does not modify the model working-set policy or introduce another cache. Display records remain inside the transported Session aggregate; their timeline, page and detail reads are verified separately.

## Alternatives considered

**Invalidate only the model working-set cache.** Rejected because ordinary history reads use the separate message-order owner.

**Transport or edit the previous machine's ordering markers.** Rejected because ordering is a local derived index and must describe the actual destination records.

**Clear every Session cache and index.** Rejected because the observed defect concerns the external ordering index. The imported Display records already contain the current messages.

## Consequences

A returning Session exposes messages accepted on either machine without reopening execution. Ordering removal participates in activation rollback, and reconstruction uses the current canonical records. Cloud Environment selection, native download, other destination mappings and independent model continuation remain separate capabilities.

## Verification

The real three-party HTTPS/WSS fixture transfers a private native copy between two enrolled Member Homes and back. It warms the original Home's history before departure, accepts and materializes another context input on the destination, then completes the second surrender, service commit and paused activation. The diagnostic shows two canonical messages at the returning Home while its old ordering contains one. Regression checks cover ordinary and paged history, actor and Part identity, current changed/untracked/ignored files, new private destinations and preservation of both original directories. See [the postmortem](../../../postmortem/0175-returned-session-retained-an-old-message-order.md).
