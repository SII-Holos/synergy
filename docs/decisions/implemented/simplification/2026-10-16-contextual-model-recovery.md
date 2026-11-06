# Decision Record: Keep model recovery within the model selector

Status: implemented

## Problem

Changing provider availability inserted or removed a full-width notice above the application. The extra row changed the reading area’s size and position while also moving unrelated navigation and resource panels. Desktop native chrome added a second inset to the notice container. Configuration guidance competed with the work being read.

## Decision

The model selector owns availability feedback. Its existing trigger shows a semantic warning icon and a short configuration or recovery label; its popover contains one explanation and a provider Settings action. The mobile Composer and model-selection command expose the same recovery. Provider changes retain the trigger and do not automatically open an overlay, shift the shell, or move focus. The shell retains its independently positioned connection status without an additional notice wrapper.

Readiness still uses the canonical provider snapshot derivation from [provider-store readiness](../bug-fix/2026-09-18-model-readiness-from-provider-store.md), with no health polling or additional event subscriptions. Since the entry represents the current model selection, `useProviders` supplies the current Scope’s snapshot, including project overrides. Loading Scope snapshots do not report missing configuration. A single affected provider remains the focus target when opening Settings. Normal selection, drafts and provider configuration remain under their existing owners.

The existing browser suite is moved to the model-selector domain. It retains recovery classification, live convergence and Settings target checks, replaces the full-width strip assertion with frame-by-frame stable geometry and trigger focus, and covers keyboard recovery, narrow viewports and Scope overrides.

## Alternatives considered

**Keep a fixed-height empty strip.** This avoids movement but permanently spends vertical space on an uncommon configuration state.

**Float a persistent warning above the application.** It avoids reflow but can obscure tabs or content and still demands attention while the user reads unrelated resources.

**Show a transient toast.** A dismissed or expired toast leaves no discoverable recovery entry for someone who has not yet configured a provider.

## Consequences

Configuration remains discoverable where users choose models, while the reading and editing layout stays stable. The concise trigger requires an explicit click for the explanation. Readiness must follow the same Scope as the selector; using only global readiness could hide usable project models or miss project-specific restrictions. No model, transport or persistence semantics change.
