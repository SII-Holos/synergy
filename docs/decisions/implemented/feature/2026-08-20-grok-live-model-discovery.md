# Decision Record: Grok live model discovery via the xAI language-models API

Status: implemented

## Problem

The grok provider model list was hardcoded to ["grok-4.5","grok-4.3","grok-build-0.1"] via DEFAULT_MODEL_IDS + static fallbackModels, so newly released models (e.g. grok-4.6) never appeared without a code change; the list also ignored account entitlements. openai-codex already auto-updates via fetchModelCatalog + ProviderCatalog refresh; grok did not register one.

## Decision

The grok profile registers fetchModelCatalog hitting GET https://api.x.ai/v1/language-models with the stored OAuth bearer (10s timeout, defensive { models: [...] } parsing, maps id/input_modalities to entries with an inputImage flag), and returns [] on non-2xx or malformed envelope so the existing catalog failure path keeps the bundled list and retries. DEFAULT_MODEL_IDS updated to ["grok-4.6","grok-4.5","grok-4.3"] (grok-build-0.1 removed: it is a coding-agent surface, not a language model, and silently dropping it from an authenticated account's live list made online/offline catalogs inconsistent) and recommended defaultModel to grok-4.6 as the offline/first-run fallback; catalog snapshot cache, 1h TTL refresh, RuntimeReload hot reload and neverVerified failure guard reused unchanged; no liveModelDiscovery field (no consumer), no config/schema/route/SDK/persistence changes.

Model entries intentionally do NOT synthesize a limit: xAI's /v1/language-models schema documents no context_length and no output limit (context_length exists only on /v1/models), so limit metadata inherits from models.dev / the bundled fallback instead of being overwritten by a made-up value. Network errors and timeouts propagate out of fetchModelCatalog so ProviderCatalog.classifyFailure records them as network/timeout rather than invalid_response; 403 responses stay an empty list so the catalog treats them as an entitlement gate, never a dead credential. The grok profile registers modelCatalogIdentity deriving a stable identity from the access-token JWT sub (falling back to email, then to the default credential identity) because xAI rotates and revokes the refresh token on every refresh and the default identity hashes the refresh token — without this, a token rotation would orphan the live snapshot and reset retained-model semantics.

## Alternatives considered

- **Only adding grok-4.6 to the hardcoded list** — rejected: it fails again at the next release; the list becomes stale again and still ignores account entitlements.
- **Relying on the static models.dev registry as the only source** — rejected: not entitlement-aware and not self-updating.
- **Using /v1/models (OpenAI-compatible) as the primary endpoint** — rejected: it mixes image/video models and carries no modality info; /v1/language-models is the orthogonal chat-model source, and the context_length gap is covered by models.dev/fallback metadata.
- **Dual-endpoint fallback to /v1/models** — rejected: a second parser for zero gain — the catalog failure path already covers upstream failure.
- **Setting liveModelDiscovery: "openai-compatible"** — rejected: a dead field with no consumer.
- **Custom modelCatalogIdentity** — rejected as unnecessary in the original proposal, then adopted after review: xAI's documented refresh-token rotation makes the default refresh-token-based identity drift, and a JWT-sub identity is the same pattern codex already uses.
- **Adding an xAI usage panel / API-key mode / Grok Build agent** — rejected: out of scope for this change.

## Consequences

New models appear automatically within the 1h TTL (or on `synergy models --refresh`) with no code change, with per-account entitlement filtering; retained-model semantics keep previously seen models selectable. Cost/limits metadata still comes from models.dev with fallback. The OAuth bearer on /v1/language-models is operationally supported but undocumented by xAI, with tier-gated 403 risk for some SuperGrok tiers — on 403 the catalog keeps the bundled list and retries without marking credentials dead. Snapshot format version 1 is unchanged; no migration. Timeouts/network failures are now classified accurately as timeout/network instead of invalid_response, so retry pacing and diagnostics match the other live-discovery providers.
