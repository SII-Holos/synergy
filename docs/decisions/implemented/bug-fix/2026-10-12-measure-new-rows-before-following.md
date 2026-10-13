# Decision Record: Measure new rows before following

Status: implemented

## Problem

A newly appended short conversation row inherited a much taller estimated size. Automatic following consumed that temporary tail before the row's disclosure entrance and deferred resize delivery accepted its actual geometry. The viewport overshot and rebounded even though its final position was correct. Stable keys protect retained measurements but cannot measure new rows.

## Decision

The pinned Solid Virtualizer resizer batches its newly mounted unmeasured targets after mount effects and grouped disclosure preparation settle. It accepts connected content boxes before parent resize delivery, publishing all initial measurements together. It drops pending targets on unobserve and disposal. Hidden targets preserve their unmeasured state until the ordinary observer can report visible geometry. History prepend preserves ordinary shift compensation and observer ordering; early publication while that compensation is pending would displace the retained anchor. Existing measurements and later streaming growth keep the coalesced observer path.

[Real browser tests](../../../../apps/web/test/components/session/conversation-process-virtualization.dom.test.ts) compose the production automatic-follow and disclosure hooks with both dependency entrypoints. A short appended row must approach its final position without overshooting or reversing. [Dependency provenance](../../../../patches/README.md#virtua-solid-initial-measurements) and [the postmortem](../../../postmortem/0070-new-row-following-rebound.md) record the implementation boundary and reproduction.

## Alternatives considered

**Disable row entrance or automatic-follow motion.** This hides the interaction that exposed the defect while retaining incorrect initial geometry. Both interactions remain useful when the tail is measured correctly.

**Remeasure the whole list on every append.** This would replace a visual defect with work proportional to historical content. Only newly mounted unmeasured targets need initial admission.

**Wait for the final offset in tests.** Both the faulty and corrected implementations converge to that value; per-frame bounds are required to detect the interruption.

## Consequences

New row admission adds one grouped layout read before paint for the new targets. The measured subset, pending references and publication are bounded by mounted rows. The patch must be checked through both published Solid entrypoints after a frozen-lockfile install. This complements retained-key measurement, history-anchor and inactive-view regressions without changing stored message data or transport semantics.
