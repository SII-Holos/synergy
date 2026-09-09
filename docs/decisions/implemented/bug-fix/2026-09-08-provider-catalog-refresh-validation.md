# Decision Record: Isolate malformed external provider catalog entries

Status: implemented

## Problem

A shared directory contains many independent providers and models. Rejecting the whole directory when one price tier adds an unknown field can discard both the local snapshot and every refresh source, leaving only built-in provider profiles. A refresh command that prints success without a usable downloaded directory conceals the failure.

## Decision

External catalog price tiers and legacy context-price metadata accept additive fields while preserving existing numeric validation. Raw pricing evidence retains these fields; configured tiers retain strict validation and existing top-level model-price extensions remain accepted. The upstream [Models.dev catalog](https://models.dev/api.json) supplies the observed nested audio and reasoning metadata shapes, and focused schema fixtures complement the pinned catalog test.

The runtime validates provider envelopes and individual models separately. Malformed entries are excluded and aggregate counts are reported without logging their contents. The existing completeness gate still requires non-empty OpenAI, Anthropic, and Google providers, so empty or incomplete responses cannot replace the last valid directory. Only accepted entries are persisted in the disposable runtime cache. Build-time snapshot validation remains strict and deterministic.

Refresh returns an explicit refreshed, failed, or disabled result. The CLI exits nonzero for failure or disabled fetching and reports success only after cache persistence and provider projection complete. Background refresh retains its nonblocking startup behavior. Provider configuration explicitly selects its existing model-price schema, so external tier extensions do not change configuration acceptance. Generated configuration contracts are verified to remain unchanged. No durable user data, authentication storage, or server route changes.

## Alternatives considered

**Add only the two observed field names.** This repairs the current payload but leaves every future external tier extension able to remove unrelated providers.

**Relax all pricing validation.** Configured context tiers benefit from rejecting misspellings and invalid rates. External metadata can evolve independently without changing existing configuration acceptance.

**Reject every catalog containing one invalid model.** A malformed independent model should not hide valid services. Completeness checks still protect against unusable full responses.

## Consequences

External schema growth no longer removes the service directory, and refresh failure is visible to CLI users. Excluded records remain unavailable until a later valid refresh; partial results can therefore contain fewer models than the source and report that reduction. Additional external metadata remains raw evidence unless a pricing adapter explicitly interprets it. Regression tests cover nested price extensions, strict configured rates, individual damaged entries, last-good cache preservation, CLI failure and success, route/bootstrap projection, and source and bundled startup.
