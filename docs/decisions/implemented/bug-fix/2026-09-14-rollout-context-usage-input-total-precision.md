# Decision Record: Preserve rollout input totals without cache breakdown

Status: implemented

## Problem

A provider may report a total prompt token count without the `input_tokens_details` breakdown. Rollout accounting represents this as a known input total with unknown cache-read and uncached contributions. Persisting a context-usage snapshot from the billing projection at that point uses only cached input tokens, which are normalized to zero, so a provider-exact report of tens of thousands of input tokens becomes `contextUsage.totalInput = 0`. The reconciler then scales category estimates to zero and attributes no context usage.

## Decision

At `finish-step`, the processor keeps `RolloutAccounting.project()` for message billing and token presentation. It separately reads `stepAccounting.tokens.input.total` for rollout context-usage enrichment and supplies that value to `ContextUsage.reconcile()`. Non-rollout turns continue to use the existing normalized input-total projection.

Context-usage enrichment still requires streamed provider input usage and an existing estimator draft. If the rollout input total is unknown, the processor does not create a snapshot. This preserves the contract that `totalInput` is the provider-exact latest-call input total without treating incomplete cache detail as zero contribution.

The rollout transport fixture can omit cache details while retaining an exact input total. Regression coverage verifies the persisted total, residual reconciliation and attributed usage, while separately locking the billing projection that has no known cached input contribution.

## Alternatives considered

**Use `usage.tokens.input` everywhere.** This conflates billing projection with provider-exact context accounting and loses the known total when only cached input is billable.

**Delay the snapshot until cache breakdown is available.** Rollout completion is already authoritative, and later reconciliation cannot recover the exact provider total from an unknown-component accounting summary.

**Infer cache reads from the stream event.** Stream usage may not expose the provider's complete breakdown; inventing a split would make persisted accounting less exact rather than more exact.

## Consequences

Provider totals remain exact even when cache attribution is unavailable. Category estimates reconcile against a nonzero total, while billing tokens continue to follow rollout pricing semantics and can legitimately report zero cached input. Unknown rollout totals still leave context usage unset. The processor reuses the rollout ledger summary already required for step accounting, and tests exercise both rollout and non-rollout behavior.
