# Decision Record: Retire the signed remote provider catalog

Status: implemented

## Problem

Synergy resolved provider metadata through two parallel channels: built-in `ProviderProfile` definitions in `packages/synergy/src/provider/builtin.ts`, and a signed remote catalog (`catalog.v1.json` + Ed25519 `.sig`) served by the `SII-Holos/synergy-provider-registry` repository, consumed through `config.providerCatalog` with an embedded public key.

In practice the remote catalog duplicated the built-in data without adding a capability:

- Every provider the catalog listed had a same-ID built-in profile, so the recommendation, alias, and fallback-model entries were maintained twice. Both copies drifted (catalog `gemini-3.1-pro-preview`/`qwen3.7-max` vs builtin `gemini-3-pro-preview`/`qwen3-max`; catalog vercel `openai/gpt-4o` vs builtin `gpt-4o`) with no authority to arbitrate.
- The remote recommendation data was dead: provider metadata resolution always prefers the profile recommendation, and all catalog providers had builtin profiles, so the catalog value was never surfaced.
- The duplication also froze the mirror. The registry's publish gate validates that catalog-referenced models still exist in the upstream `models.dev` snapshot before committing the mirror. When models.dev removed `github-copilot/gemini-3.1-pro-preview`, every sync run failed on the stale catalog reference and the `models.json` mirror stopped updating with no alerting — the gate was working as designed, but the catalog it protected had no reason to exist.

The `models.json` mirror itself has real value: `packages/synergy/src/provider/models.ts` uses it as a fallback when `models.dev` is unreachable, and the client validates it with its own schema, so a bad mirror degrades gracefully instead of breaking.

## Decision

Provider metadata now has a single source of truth: the built-in `ProviderProfile` definitions. The signed remote catalog path is removed end to end:

- `ProviderCatalog` no longer fetches, verifies, caches, or merges a remote catalog. The `DEFAULT_REGISTRY_URL`/`DEFAULT_PUBLIC_KEY` constants, `RemoteCatalog` schema, signature verification, remote refresh/cooldown machinery, and `Global.Path.providerCatalogCache` are gone. `resolve` serves the bundled models.dev projection, configured providers, and live per-account discovery — the remaining behavior unchanged.
- The `providerCatalog` config key is removed from the schema, the providers domain registry, the SDK/OpenAPI contracts, and the config reference. A `20260905-config-remove-provider-catalog` migration deletes the key from monolithic configs and `20-providers.jsonc` fragments.
- `SYNERGY_DISABLE_PROVIDER_CATALOG_FETCH` no longer exists (the fetch path is gone).
- The registry repository keeps its remaining job — an unmodified `models.dev/api.json` mirror refreshed every six hours with structural pre-publish validation — and retires the catalog, signature pipeline, and consistency gate.

## Alternatives considered

**Minimal repair of the sync failure.** Deleting the stale `gemini-3.1-pro-preview` entry from `catalog.v1.json` would have unblocked the registry within one sync cycle. It lost because the failure was a symptom: dual-source duplication was already drifting in both directions with no owner, the remote recommendation data never took effect, and the next upstream model removal would re-freeze the mirror. No mechanism existed to keep both copies coherent without standing human effort.

**Making the dual-source design real.** Cleaning the drift, letting remote recommendations actually override builtin profiles, and teaching the publish gate to auto-drop stale references would have preserved the ability to retune provider metadata without a client release. It lost because that capability was never exercised (the catalog recommendation path was dead data), the Ed25519 key-rotation contract would still require a client release for key changes anyway, and the maintenance cost — two sources, a signing pipeline, a key embedded in every client — bought nothing the builtin profiles do not already provide.

**Keeping the catalog but splitting the repos.** Moving `catalog.v1.json` to its own repository would have isolated the consistency gate from the mirror, but it preserved the duplication and drift instead of eliminating the cause.

## Consequences

- Provider metadata changes now require a Synergy release. The retired ability to hot-tune provider recommendations from the registry was never used, and drift showed the double-maintenance cost was already being paid in errors.
- The registry repository reduces to one workflow and one artifact. Its structural publish gate keeps validating that the mirror parses and carries the core providers; an upstream content change can no longer block the mirror because nothing references specific model IDs.
- Users who configured `providerCatalog` are migrated automatically by the config migration; the key is deleted from monolithic configs and `20-providers.jsonc` in the same startup run.
- The models.dev fallback mirror for unreachable networks resumes updating after the registry PR merges and the first scheduled sync lands.
