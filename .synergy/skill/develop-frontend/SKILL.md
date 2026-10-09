---
name: develop-frontend
description: Implement or review Synergy Web and shared UI changes across apps/web and packages/ui. Use for components, contexts/stores, navigation, settings, dialogs, workbench surfaces, semantic icons, themes, responsive behavior, accessibility, frontend API calls, event sync, and product interaction changes.
---

# Develop the Frontend

Preserve domain state and generated API ownership, public theme tokens, localization, real provider lifetimes and the current product contract. Use the verification table before choosing expensive checks. Read only references for the affected domain.

## Read the Contracts

1. Read `apps/web/AGENTS.md` and [Web product contract](../../../apps/web/PRODUCT.md).
2. Read [Frontend data sync](../../../docs/architecture/frontend-data-sync.md) for contexts, snapshots, events, streaming, composer intent, or loaded buckets.
3. Read [Browser runtime](../../../docs/architecture/browser-runtime.md) for Browser UI or Desktop/Web presentation changes.
4. Load `change-server-api` when the UI needs a new or changed server contract; load `add-tool` for tool-card presentation.

## Verify

Start with `bun run verify plan`. During iteration run the narrow component, model or context test; before publication use `bun run verify local --test apps/web/test/<domain>/<file>.test.ts` with all relevant tests explicitly selected. The entry point uses canonical coverage executors and static gates; it leaves complete package thresholds and platform acceptance to CI.

| Change                                                      | Additional local evidence                                                                                                                                                             |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New source or test fixture                                  | Fresh focused LCOV includes each new measurable source; read [browser fixtures](references/browser-fixtures.md) for real layout, virtualization and provider ownership.               |
| Coverage policy, instrumentation, removed coverage          | `bun run verify coverage --package apps/web` (or the actual owner).                                                                                                                   |
| Bootstrap, browser capabilities, bundler or package exports | Web production build, browser crypto contract and private HTTP smoke; `verify local` runs these for its known entry paths. Inspect the plan for other affected boundaries.            |
| Copy, translations or locale formatting                     | Extract catalogs and run `localization:check`; verify cold start, switching, errors and lazy catalogs as described in [presentation](references/presentation.md#localize-product-ui). |
| Visible interaction or layout                               | Inspect changed states, themes, focus and narrow geometry in one isolated runtime.                                                                                                    |
| Native Browser, window chrome, protocol or Electron         | Exercise the actual Desktop boundary using its owning skill.                                                                                                                          |

Run static gates after browser tests and builds finish; they mutate shared generated artifacts. Do not run both whole Web/UI suites on every edit. Broaden only for unresolved failures or affected shared behavior. Load the relevant domain reference below before changing its contract.

## Message process and execution details

Read [the domain guidance](references/conversation.md#message-process-and-execution-details) when this area is affected.

## Settings recovery

Read [the domain guidance](references/state-and-recovery.md#settings-recovery) when this area is affected.

## Library and statistics recovery

Read [the domain guidance](references/state-and-recovery.md#library-and-statistics-recovery) when this area is affected.

## Preserve State and API Ownership

Read [the domain guidance](references/state-and-recovery.md#preserve-state-and-api-ownership) when this area is affected.

## Preserve Browser Capability Boundaries

1. Route ordinary App/UI identifiers through `generateUUID()` or `generateRandomBytes()` from the shared utility package. Do not call `crypto.randomUUID()` or `crypto.getRandomValues()` directly from browser source.
2. Use `generateSecureUUID()` or `generateSecureRandomBytes()` for authentication state, nonces, credentials, and other security-sensitive values. A missing secure source must fail only the affected operation; it must never fall back to `Math.random()`.
3. Keep optional browser APIs out of module-scope startup paths. Gate Clipboard, Notifications, credentials, media, and other Secure Context capabilities at the owning action and provide a local unavailable or error state.
4. Treat non-loopback private-network HTTP as a supported Web deployment. When capability or bootstrap code changes, verify an actual non-Secure Context rather than relying on localhost.

## Localize Product UI

Read [the domain guidance](references/presentation.md#localize-product-ui) when this area is affected.

## Use Semantic Icons

Read [the domain guidance](references/presentation.md#use-semantic-icons) when this area is affected.

## Preserve Product Presentation

Read [the domain guidance](references/presentation.md#preserve-product-presentation) when this area is affected.

## Execution details

Read [the domain guidance](references/conversation.md#execution-details) when this area is affected.

## Preserve Loading Boundaries

Read [the domain guidance](references/state-and-recovery.md#preserve-loading-boundaries) when this area is affected.

## Change Themes and Color Tokens

Read [the domain guidance](references/presentation.md#change-themes-and-color-tokens) when this area is affected.

## Handoff

Report changed behavior, ownership, focused tests, visual evidence and pending CI or platform checks. Distinguish local verification from merge readiness.

## Replaceable plugin presentation

Read [the domain guidance](references/workbench-acceptance.md#replaceable-plugin-presentation) when this area is affected.

## Complete workbench acceptance

Read [the domain guidance](references/workbench-acceptance.md#complete-workbench-acceptance) when this area is affected.

## Large-history verification

Read [the domain guidance](references/workbench-acceptance.md#large-history-verification) when this area is affected.

## Resource Workspace changes

Read [the domain guidance](references/resources.md#resource-workspace-changes) when this area is affected.

## Conversation navigation motion

Read [the domain guidance](references/conversation.md#conversation-navigation-motion) when this area is affected.

## Conversation process and read-only evidence

Read [the domain guidance](references/conversation.md#conversation-process-and-read-only-evidence) when this area is affected.

## Verify File Review and Restoration

Read [the domain guidance](references/resources.md#verify-file-review-and-restoration) when this area is affected.
