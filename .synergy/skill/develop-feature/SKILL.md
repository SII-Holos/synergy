---
name: develop-feature
description: Add, change, graduate or retire a first-party Synergy feature, experimental module, prompt/context strategy or risky optimization. Use when declaring feature availability, selecting runtime components or introducing a behavior flag.
---

# Develop a Feature

Read [Feature lifecycle](../../../docs/architecture/feature-lifecycle.md), the owning architecture document and package AGENTS.md. This workflow concerns product availability; business parameters, execution experiments and third-party plugin permissions keep their own owners.

## Declare and implement

1. Identify the owning module, affected operations, dependencies, disabled behavior and verification. Larger user features, significant prompt/context changes and risky optimizations start experimental. Do not add switches mechanically to bug fixes or unchanged refactors.
2. Add a stable unique ID to the owner's pure `src/features.ts` and expose `componentFeatures` through the factory's `features` metadata. Declare maturity, activation, name and description. Bind a whole component only when that component is the intended unit of availability. Registration, routes, tools and services require `restart`; a local behavior choice can use `live`.
3. Write a failing behavioral test at the real entrypoint. Check default-off, both choices and independent Runtime state. For live behavior, pause an operation before reload and prove that it keeps its choice while the next operation changes.
4. Use `Features.enabled(id)` once at the owning operation boundary. Keep the alternative local; reuse surrounding implementation. Select prompt text before dispatch. If a worker needs that choice, carry it in the existing in-memory request context. Never add task snapshots, a second database or an alternate configuration source.
5. Declare required components and put optional integrations in explicit bridges. A stable owner cannot depend on an experimental component, including through a bridge. Split schema/migration maintenance from runtime capability when offline data operations need dormant data. Preserve existing migration IDs and owner checks.
6. Run `bun run feature:gen`. Inspect generated package metadata and Web descriptors. No hand-maintained installed feature directory, raw environment toggles or client-side default calculation is allowed. If the feature has UI, follow [develop-frontend](../develop-frontend/SKILL.md) for shared controls, semantic icons and rendered verification; gate every ordinary entrypoint with capabilities, including settings/search, mobile, restored panels and deep links.
7. For config/API changes, follow `change-persistence` and `change-server-api`, regenerate SDK/config references and translations, and update relevant product/help text. Add an implemented decision record for a nontrivial change.

## Choose the control point

| Change                          | Declaration                                                                   | Implementation                                                                                                               |
| ------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Entire module                   | Bind `component` to the owner; use `restart`                                  | Selection omits registration, adapters and services. Do not add another module-enable check.                                 |
| UI within a shared module       | Leave `component` unset; use `restart` for registered capabilities            | Contribute its own capability ID and gate ordinary UI entrypoints on that capability. Keep shared services with their owner. |
| Prompt, context or optimization | Leave `component` unset; use `live` when the next operation can change safely | Read once at the existing operation boundary and keep the choice local.                                                      |

For a behavior experiment, the owning implementation selects the alternative without duplicating the request pipeline:

```ts
const candidate = Features.enabled("owner.prompt-v2")
const system = candidate ? candidatePrompt(input) : currentPrompt(input)
await dispatch({ ...request, system })
```

Use the actual owner's ID and existing request assembly functions. Do not query the flag again after an `await` within that operation. Test through that entrypoint. Follow the [Web product contract](../../../apps/web/PRODUCT.md#design-principles) for experimental settings controls and concise copy. Keep names and descriptions in the declaration, generate Web descriptors, and translate them through the existing catalogs.

## Verify

- Test fresh and upgraded homes; existing business parameters cannot implicitly opt in.
- Assert absent routes, tools, Agents, workflow descriptors, services and automatic recovery, while shared stable capabilities remain intact.
- Test source and installed selection against the same declarations, sealed metadata, pinned workers and two Runtime instances. Use real temporary homes and local archives.
- For restart activation, save, inspect pending state, restart, then inspect actual capability and behavior. Test same-URL reconnect and late replies without losing unsaved drafts.
- Retry failed catalog reads and saves through their existing owners. Retained unavailable choices must allow removal and undo before saving.
- Save dependent choices together and disable a dependency while running; pending state must describe the next composition without changing the current one. Reject stable-to-experimental dependency chains even when all experiments are enabled.
- Disable, change unrelated configuration, run backup/import/maintenance and re-enable. Preserve dormant business settings and history; test Continue on an old owner-bound task separately from a new ordinary human message, which follows the existing independent-root admission contract.
- Owner tests opt into experimental features explicitly through the canonical Feature plan or fixture Home configuration. Keep default product fixtures unselected so absence and reinstall remain observable. Installing a maintenance dependency does not select its runtime owner.
- Run focused domain tests, `feature:check`, dependency and package checks, generated-contract checks and the applicable Web production/private-HTTP smoke. Use `develop-synergy` for the isolated runtime.

## Graduate or retire

1. Verify behavior, disable/re-enable and relevant performance before graduation. Set maturity to stable so old opt-ins cannot restrict the capability.
2. Delete the experimental alternative, obsolete flag reads, copy and tests in the same change. Keep one supported implementation. For retirement, remove the declaration and implementation instead.
3. Add a new versioned migration in the existing config migration runner that calls `retireFeaturePreferences` with the explicit retired IDs. Test repeated execution and preservation of other choices and business data. Do not reuse the initial normalization receipt or clear unknown uninstalled IDs.
4. Regenerate metadata, SDK/config references and translations. Update owning documentation and review the final diff for leftover branches. Different experiments use new IDs.
