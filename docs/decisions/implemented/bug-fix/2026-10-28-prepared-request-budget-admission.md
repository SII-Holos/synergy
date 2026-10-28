# Decision Record: Native turn admission uses the prepared request budget

Status: implemented

## Problem

The projected prompt plan omits instructions added during final preparation, including the agent preamble, contributed instructions and a user system override. A later check can therefore discover pressure that the initial compaction decision did not see. Mapping both soft pressure and a hard context overflow to the same terminal error hides whether a response still fits. Compaction selection also returns zero when there is no earlier history, which does not establish that the request exceeds context.

## Decision

Native turn admission measures the complete prepared request, including final system transformations and the active model tool definitions. Request assembly remains with its existing owner. Conversation generation and native compaction reuse the prepared result instead of independently reconstructing instructions or rerunning final hooks for the same request.

Soft pressure requests useful compaction; it is not evidence of a hard context overflow. An empty historical region is a no-op rather than a failed summary. When the complete conversation request still fits, a new task can proceed without a summary, using the existing output clamp. A pending explicit no-op is settled without committing summary coverage or leaving a request that repeats indefinitely. An irreducible hard overflow still stops before provider dispatch.

Historical prefix selection, atomic tool exchanges, retained tails and commit-only coverage continue to follow the [prefix coverage decision](2026-10-26-compaction-prefix-coverage.md). Native summary preparation and tool-execution restrictions continue to follow the [stable-prefix decision](../architecture/2026-10-11-stable-prefix-local-compaction.md). A no-op does not authorize dropping history, removing system instructions or tools, or manufacturing a summary boundary.

## Alternatives considered

**Increase configured context limits or disable automatic compaction.** These changes alter when the defect appears without repairing incomplete measurement, error classification or empty-history handling. Model limits remain independently verified provider metadata.

**Remove the final check.** This admits requests whose completed system content genuinely exceeds the available window. The final hard safety check remains necessary.

**Treat every zero selected prefix as an overflow.** An empty region and an oversized atomic prefix both produce zero, but only the latter demonstrates that a candidate cannot fit. Callers need an explicit no-history outcome rather than a fabricated budget failure.

**Rebuild the agent prompt inside the budgeter.** Copying assembly rules introduces a second implementation of preambles, contributions and hooks. Measuring and reusing the prepared request keeps those rules with the existing request owner.

## Consequences

Admission includes the cost of completed request preparation. A new conversation can cross the soft threshold without creating a useless summary call, while a real hard overflow remains a local failure. No-op completion is distinct from successful compression and cannot change the effective-history cursor. Focused regressions exercise assembled instructions, soft-only pressure, hard overflow, explicit empty-history requests and prepared-request reuse; they do not establish live-provider token accuracy or cache savings.
