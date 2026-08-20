# Decision Record: Grok live model discovery via the xAI language-models API

Status: implemented

## Problem

The grok provider model list was hardcoded to ["grok-4.5","grok-4.3","grok-build-0.1"] via DEFAULT_MODEL_IDS + static fallbackModels, so newly released models (e.g. grok-4.6) never appeared without a code change; the list also ignored account entitlements. openai-codex already auto-updates via fetchModelCatalog + ProviderCatalog refresh; grok did not register one.

## Decision

The grok profile registers fetchModelCatalog hitting GET https://api.x.ai/v1/language-models with the stored OAuth bearer (10s timeout, defensive { models: [...] } parsing, maps id/inputImage/context_length, returns [] on non-2xx or malformed envelope so the existing catalog failure path keeps the bundled list and retries); DEFAULT_MODEL_IDS updated to ["grok-4.6","grok-4.5","grok-4.3","grok-build-0.1"] and recommended defaultModel to grok-4.6 as the offline/first-run fallback; catalog snapshot cache, 1h TTL refresh, RuntimeReload hot reload and neverVerified failure guard reused unchanged; no liveModelDiscovery field (no consumer), no config/schema/route/SDK/persistence changes.

## Alternatives considered

- **Only adding grok-4.6 to the hardcoded list** — rejected: it fails again at the next release; the list becomes stale again and still ignores account entitlements.
- **Relying on the static models.dev registry as the only source** — rejected: not entitlement-aware and not self-updating.
- **Using /v1/models (OpenAI-compatible) as the primary endpoint** — rejected: it mixes image/video models and carries no modality info; /v1/language-models is the orthogonal chat-model source, and the context_length gap is covered by models.dev/fallback metadata.
- **Dual-endpoint fallback to /v1/models** — rejected: a second parser for zero gain — the catalog failure path already covers upstream failure.
- **Setting liveModelDiscovery: "openai-compatible"** — rejected: a dead field with no consumer.
- **Custom modelCatalogIdentity** — rejected: unneeded — BASE_URL is fixed and the default credential identity already isolates snapshots.
- **Adding an xAI usage panel / API-key mode / Grok Build agent** — rejected: out of scope for this change.

## Consequences

New models appear automatically within the 1h TTL (or on `synergy models --refresh`) with no code change, with per-account entitlement filtering; retained-model semantics keep previously seen models selectable. Cost/limits metadata still comes from models.dev with fallback. The OAuth bearer on /v1/language-models is operationally supported but undocumented by xAI, with tier-gated 403 risk for some SuperGrok tiers — on 403 the catalog keeps the bundled list and retries without marking credentials dead. Snapshot format version 1 is unchanged; no migration.
