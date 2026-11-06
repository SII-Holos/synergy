# Decision Record: Provider labels in recent model choices

Status: implemented

## Problem

The model quick switcher's Recent group mixes provider accounts. Different connections can expose the same model name, so a model-only row does not identify which account will receive the request. Provider-grouped choices already communicate their source through the group heading.

## Decision

Only Recent rows show a second, subordinate line with the provider's existing display name. The label reuses the same account-aware name shown by provider group headings. Provider-grouped model rows remain single-line, and model settings keep their existing density. Search, ordering and selection continue to use the existing provider and model identities. The selection check retains its separate trailing column.

## Alternatives considered

**Show a source line on every model row.** Rejected because provider-grouped lists would repeat their heading on every row and become unnecessarily tall.

**Show sources only in a tooltip or only for duplicate model names.** Rejected because account identification should be visible before interaction and occupy a consistent position throughout Recent.

**Regroup Recent by provider or merge same-name models into an account submenu.** Rejected because Recent should preserve recency across accounts and selecting a connection should remain one action.

## Consequences

Recent rows are taller, but account identity is visible alongside the model. Existing provider display names remain authoritative; this change adds no account-naming rules, persisted preferences, or selection state. Rendered-browser tests cover same-name models across two accounts, single-line provider groups, long labels at narrow widths, search and keyboard selection.
